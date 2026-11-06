use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, PhysicalRect, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri_plugin_dialog::DialogExt;

const SECONDARY_LABEL: &str = "secondary";

/// Folga (em pixels físicos) entre o topo da área útil da tela e o widget.
const TOP_MARGIN: i32 = 16;

/// Posição centralizada na horizontal e encostada na parte superior da tela.
///
/// Usa a área útil do monitor (descontando a barra de tarefas), então funciona
/// igual em monitores primários, secundários, com ou sem escala diferente.
fn top_centered_position(
    work_area: &PhysicalRect<i32, u32>,
    width: i32,
    height: i32,
) -> PhysicalPosition<i32> {
    let area_x = work_area.position.x;
    let area_y = work_area.position.y;
    let area_width = work_area.size.width as i32;
    let area_height = work_area.size.height as i32;

    let max_x = area_x + (area_width - width).max(0);
    let max_y = area_y + (area_height - height).max(0);

    PhysicalPosition::new(
        (area_x + (area_width - width) / 2).clamp(area_x, max_x),
        (area_y + TOP_MARGIN).min(max_y),
    )
}

/// Coloca uma janela centralizada no topo do monitor em que ela está.
fn place_at_top_center(window: &WebviewWindow) -> tauri::Result<()> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };
    let Some(monitor) = monitor else {
        return Ok(());
    };

    let size = window.inner_size()?;
    window.set_position(top_centered_position(
        monitor.work_area(),
        size.width as i32,
        size.height as i32,
    ))
}

/// Dois monitores são a mesma tela quando têm origem e tamanho iguais.
fn same_monitor(a: &Monitor, b: &Monitor) -> bool {
    a.position() == b.position() && a.size() == b.size()
}

/// Monitor em que a janela principal está, quando ela já existe.
fn main_monitor(app: &AppHandle) -> Option<Monitor> {
    app.get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
}

/// Monitor que deve hospedar o widget secundário.
///
/// Prefere o monitor em que a janela já está — assim configurações com três
/// telas mantêm a escolha do usuário — e recorre ao primeiro monitor livre
/// quando ela está no mesmo monitor da janela principal.
fn secondary_target_monitor(
    app: &AppHandle,
    current: Option<&Monitor>,
) -> Result<Monitor, String> {
    let monitors = app.available_monitors().map_err(|error| error.to_string())?;
    if monitors.len() < 2 {
        return Err("Apenas um monitor foi detectado neste computador.".to_string());
    }

    let main_monitor = main_monitor(app);
    let is_free = |monitor: &Monitor| match &main_monitor {
        Some(main) => !same_monitor(monitor, main),
        None => true,
    };

    current
        .filter(|monitor| is_free(monitor))
        .cloned()
        .or_else(|| monitors.iter().find(|monitor| is_free(monitor)).cloned())
        .ok_or_else(|| "Não foi possível localizar o segundo monitor.".to_string())
}

/// Coloca o widget secundário centralizado no topo do monitor que não hospeda
/// a janela principal.
///
/// A conta é feita aqui porque o backend conhece a área útil de cada monitor
/// (já descontando a barra de tarefas). No frontend, `setPosition` usa
/// coordenadas do desktop inteiro — somar a origem do monitor à mão é o que
/// trazia a segunda janela para cima da primeira.
fn place_secondary_top_center(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let current = window.current_monitor().map_err(|error| error.to_string())?;
    let target = secondary_target_monitor(app, current.as_ref())?;

    let size = window.inner_size().map_err(|error| error.to_string())?;
    window
        .set_position(top_centered_position(
            target.work_area(),
            size.width as i32,
            size.height as i32,
        ))
        .map_err(|error| error.to_string())
}

/// Diz se o canto da janela ainda cai dentro de algum monitor conectado.
///
/// Serve para detectar janelas que ficaram fora da tela depois de uma mudança
/// no layout de monitores (desconectar um monitor, por exemplo).
fn is_inside_any_monitor(monitors: &[Monitor], position: PhysicalPosition<i32>) -> bool {
    const TOLERANCE: i32 = 8;

    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        position.x >= origin.x - TOLERANCE
            && position.y >= origin.y - TOLERANCE
            && position.x < origin.x + size.width as i32 - TOLERANCE
            && position.y < origin.y + size.height as i32 - TOLERANCE
    })
}

/// Impede que duas chamadas concorrentes criem dois widgets secundários.
#[derive(Default)]
struct DualScreenState(Mutex<()>);

/// Mostra ou esconde o widget secundário no outro monitor.
///
/// O widget secundário é criado sob demanda, na primeira vez que a opção é
/// ativada, centralizado na parte superior do outro monitor, e apenas escondido
/// quando a opção é desativada (assim ele mantém a posição escolhida pelo
/// usuário). Cada janela pode ser arrastada de forma independente.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn set_second_screen(
    app: AppHandle,
    state: tauri::State<'_, DualScreenState>,
    visible: bool,
) -> Result<bool, String> {
    // A criação de janelas precisa acontecer fora da thread principal (daí o
    // comando assíncrono) e serializada, senão duas chamadas simultâneas (por
    // exemplo, os efeitos duplicados do React em desenvolvimento) criam dois
    // widgets com o mesmo rótulo.
    let _guard = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if !visible {
        if let Some(window) = app.get_webview_window(SECONDARY_LABEL) {
            window.hide().map_err(|error| error.to_string())?;
        }
        return Ok(false);
    }

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "Janela principal não encontrada.".to_string())?;

    if let Some(window) = app.get_webview_window(SECONDARY_LABEL) {
        // Se o layout de monitores mudou desde a última vez, a janela pode ter
        // ficado fora de qualquer tela. Nesse caso ela volta ao topo, mas uma
        // posição escolhida pelo usuário é preservada.
        let monitors = app.available_monitors().unwrap_or_default();
        let off_screen = window
            .outer_position()
            .map(|position| !is_inside_any_monitor(&monitors, position))
            .unwrap_or(false);

        window.show().map_err(|error| error.to_string())?;
        if off_screen {
            if let Err(error) = place_secondary_top_center(&app, &window) {
                eprintln!("Não foi possível reposicionar o widget secundário: {error}");
            }
        }
        return Ok(true);
    }

    let current = main.current_monitor().map_err(|error| error.to_string())?;
    let target = secondary_target_monitor(&app, current.as_ref())?;

    let main_size = main.inner_size().map_err(|error| error.to_string())?;
    let main_scale = main.scale_factor().map_err(|error| error.to_string())?;
    let logical = main_size.to_logical::<f64>(main_scale);

    let target_scale = target.scale_factor();
    let width = (logical.width * target_scale).round() as i32;
    let height = (logical.height * target_scale).round() as i32;

    // Mesmo alinhamento da janela principal: centro horizontal, topo da tela.
    let placement = top_centered_position(target.work_area(), width, height);

    let window = WebviewWindowBuilder::new(
        &app,
        SECONDARY_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Pericles Desktop Widget")
    .inner_size(logical.width, logical.height)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;

    window
        .set_position(placement)
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;

    Ok(true)
}

/// Reposiciona uma janela do widget no topo centralizado do monitor correto.
///
/// A janela secundária vai para o monitor que não hospeda a principal; a
/// principal permanece no monitor em que está. O cálculo fica no backend para
/// valer em qualquer arranjo de monitores e escala de tela.
#[tauri::command]
fn snap_widget_top_center(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "Janela não encontrada.".to_string())?;

    if label == SECONDARY_LABEL {
        place_secondary_top_center(&app, &window)
    } else {
        place_at_top_center(&window).map_err(|error| error.to_string())
    }
}

#[derive(Clone, serde::Serialize)]
struct DiskInfo {
    name: String,
    total: u64,
    available: u64,
}

#[derive(Clone, serde::Serialize)]
struct SystemMetrics {
    cpu_usage: f32,
    memory_used: u64,
    memory_total: u64,
    network_rx: u64,
    network_tx: u64,
    battery_percent: Option<f32>,
    gpu_name: Option<String>,
    gpu_usage: Option<f32>,
    gpu_temperature: Option<u32>,
    disks: Vec<DiskInfo>,
}

/// Intervalo entre as amostras do coletor em segundo plano.
const METRICS_SAMPLE_INTERVAL: Duration = Duration::from_millis(1000);
/// A GPU é lida com menos frequência: sem NVIDIA o Windows exige um processo
/// PowerShell, caro demais para rodar a cada segundo.
const GPU_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
/// Sem nenhuma janela pedindo métricas por esse tempo, a GPU deixa de ser lida
/// e o coletor passa a amostrar em ritmo reduzido.
const GPU_IDLE_TIMEOUT: Duration = Duration::from_secs(20);
/// Ritmo do coletor quando ninguém está exibindo as métricas.
const IDLE_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

/// Última amostra pronta, compartilhada entre o coletor e o comando.
///
/// Antes, cada chamada refazia toda a coleta — incluindo um `sleep` para o
/// cálculo de CPU e, em GPUs não-NVIDIA, um processo PowerShell inteiro.
/// Agora o comando apenas devolve a amostra mais recente e responde na hora.
#[derive(Default)]
struct MetricsStore {
    snapshot: Mutex<Option<SystemMetrics>>,
    ready: Condvar,
    last_request: Mutex<Option<Instant>>,
}

static METRICS_STORE: OnceLock<Arc<MetricsStore>> = OnceLock::new();

fn metrics_store() -> Arc<MetricsStore> {
    METRICS_STORE
        .get_or_init(|| {
            let store = Arc::new(MetricsStore::default());
            let sampler = Arc::clone(&store);
            if let Err(error) = std::thread::Builder::new()
                .name("metrics-sampler".to_string())
                .spawn(move || sample_metrics_loop(sampler))
            {
                eprintln!("Não foi possível iniciar o coletor de métricas: {error}");
            }
            store
        })
        .clone()
}

#[tauri::command(async)]
fn get_system_metrics() -> Result<SystemMetrics, String> {
    let store = metrics_store();
    if let Ok(mut last_request) = store.last_request.lock() {
        *last_request = Some(Instant::now());
    }

    let guard = store
        .snapshot
        .lock()
        .map_err(|_| "Falha ao ler as métricas do sistema".to_string())?;

    if let Some(snapshot) = guard.as_ref() {
        return Ok(snapshot.clone());
    }

    // Primeira chamada: aguarda a amostra inicial do coletor. A primeira
    // leitura de CPU do sysinfo pode levar ~1,5 s em um processo recém-aberto,
    // por isso o coletor já começa no setup do aplicativo.
    let (guard, _) = store
        .ready
        .wait_timeout(guard, Duration::from_millis(2000))
        .map_err(|_| "Falha ao ler as métricas do sistema".to_string())?;

    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "Métricas ainda não disponíveis".to_string())
}

/// Indica se alguma janela pediu métricas nos últimos segundos.
fn metrics_requested_recently(store: &MetricsStore) -> bool {
    store
        .last_request
        .lock()
        .ok()
        .and_then(|last_request| *last_request)
        .is_some_and(|at| at.elapsed() < GPU_IDLE_TIMEOUT)
}

/// Coleta em segundo plano: mantém a amostra sempre pronta para o comando.
fn sample_metrics_loop(store: Arc<MetricsStore>) {
    use sysinfo::{Networks, System};

    let mut system = System::new();
    system.refresh_cpu_all();
    system.refresh_memory();

    let mut networks = Networks::new_with_refreshed_list();
    let mut disks = sysinfo::Disks::new_with_refreshed_list();
    let battery_manager = battery::Manager::new().ok();

    let mut nvml: Option<nvml_wrapper::Nvml> = None;
    let mut gpu_counter: Option<gpu_counter::GpuCounter> = None;
    let mut gpu: (Option<String>, Option<f32>, Option<u32>) = (None, None, None);
    let mut gpu_sampled_at: Option<Instant> = None;
    let mut first_pass = true;

    // O sysinfo precisa de um intervalo mínimo entre duas leituras para
    // calcular o uso de CPU.
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(200)));

    loop {
        let started = Instant::now();

        system.refresh_cpu_all();
        system.refresh_memory();
        networks.refresh();
        disks.refresh();

        let metrics_in_use = metrics_requested_recently(&store);
        let gpu_due =
            gpu_sampled_at.is_none_or(|at| started.duration_since(at) >= GPU_SAMPLE_INTERVAL);

        // Na primeira volta a GPU é ignorada, para o widget não esperar a
        // inicialização do NVML; ela entra na amostra seguinte.
        if !first_pass && gpu_due && metrics_in_use {
            gpu = sample_gpu(&mut nvml, &mut gpu_counter);
            gpu_sampled_at = Some(started);
        }

        let battery_percent = battery_manager
            .as_ref()
            .and_then(|manager| manager.batteries().ok())
            .and_then(|mut batteries| batteries.next())
            .and_then(|battery| battery.ok())
            .map(|battery| battery.state_of_charge().value * 100.0);

        let mut rx = 0u64;
        let mut tx = 0u64;
        for (_name, data) in &networks {
            rx += data.total_received();
            tx += data.total_transmitted();
        }

        let snapshot = SystemMetrics {
            cpu_usage: system.global_cpu_usage(),
            memory_used: system.used_memory(),
            memory_total: system.total_memory(),
            network_rx: rx,
            network_tx: tx,
            battery_percent,
            gpu_name: gpu.0.clone(),
            gpu_usage: gpu.1,
            gpu_temperature: gpu.2,
            disks: disks
                .iter()
                .map(|disk| DiskInfo {
                    name: disk.name().to_string_lossy().to_string(),
                    total: disk.total_space(),
                    available: disk.available_space(),
                })
                .collect(),
        };

        if let Ok(mut latest) = store.snapshot.lock() {
            *latest = Some(snapshot);
            store.ready.notify_all();
        }

        first_pass = false;

        // Sem ninguém pedindo métricas (por exemplo, com as métricas
        // desligadas nas configurações), o coletor desacelera.
        let interval = if metrics_requested_recently(&store) {
            METRICS_SAMPLE_INTERVAL
        } else {
            IDLE_SAMPLE_INTERVAL
        };
        let elapsed = started.elapsed();
        if elapsed < interval {
            std::thread::sleep(interval - elapsed);
        }
    }
}

/// Lê a GPU via NVML (NVIDIA) ou, na falta dele, pelo contador de desempenho
/// nativo do Windows (PDH) — os mesmos dados do Gerenciador de Tarefas.
fn sample_gpu(
    nvml: &mut Option<nvml_wrapper::Nvml>,
    fallback: &mut Option<gpu_counter::GpuCounter>,
) -> (Option<String>, Option<f32>, Option<u32>) {
    if nvml.is_none() {
        *nvml = nvml_wrapper::Nvml::init().ok();
    }

    if let Some(instance) = nvml.as_ref() {
        return match instance.device_by_index(0) {
            Ok(device) => {
                let name = device.name().ok();
                let usage = device.utilization_rates().ok().map(|u| u.gpu as f32);
                let temp = device
                    .temperature(nvml_wrapper::enum_wrappers::device::TemperatureSensor::Gpu)
                    .ok();
                (name, usage, temp)
            }
            Err(_) => (None, None, None),
        };
    }

    // Fallback para GPUs não-NVIDIA (ex.: AMD/Intel).
    if fallback.is_none() {
        *fallback = gpu_counter::GpuCounter::new();
    }
    let usage = fallback.as_mut().and_then(|counter| counter.usage());
    (None, usage, None)
}

/// Contador de uso da GPU do Windows, via PDH.
///
/// Antes, GPUs sem NVIDIA eram lidas por um processo PowerShell com
/// `Get-Counter`, que chegava a consumir segundos de CPU a cada amostra.
/// O PDH lê a mesma informação em poucos milissegundos.
mod gpu_counter {
    use std::time::{Duration, Instant};

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhExpandWildCardPathW,
        PdhGetFormattedCounterValue, PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA,
        PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE, PDH_MORE_DATA,
    };

    const COUNTER_PATH: &str = "\\GPU Engine(*)\\Utilization Percentage";
    /// De tempos em tempos a lista de motores gráficos é relida, para incluir
    /// processos que começaram a usar a GPU depois do widget.
    const EXPAND_INTERVAL: Duration = Duration::from_secs(60);

    pub struct GpuCounter {
        query: isize,
        counters: Vec<isize>,
        path: Vec<u16>,
        expanded_at: Instant,
    }

    impl GpuCounter {
        pub fn new() -> Option<Self> {
            let mut counter = Self {
                query: 0,
                counters: Vec::new(),
                path: COUNTER_PATH.encode_utf16().chain(std::iter::once(0)).collect(),
                expanded_at: Instant::now(),
            };
            counter.reopen()?;
            Some(counter)
        }

        /// Uso atual da GPU em porcentagem (soma de todos os motores).
        pub fn usage(&mut self) -> Option<f32> {
            if self.counters.is_empty() || self.expanded_at.elapsed() >= EXPAND_INTERVAL {
                self.reopen()?;
            }

            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return None;
                }

                let mut total = 0.0f64;
                let mut found = false;
                for &counter in &self.counters {
                    let mut value = PDH_FMT_COUNTERVALUE::default();
                    let status =
                        PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut value);
                    if status != 0
                        || (value.CStatus != PDH_CSTATUS_VALID_DATA
                            && value.CStatus != PDH_CSTATUS_NEW_DATA)
                    {
                        continue;
                    }
                    let usage = value.Anonymous.doubleValue;
                    if usage.is_finite() {
                        total += usage.max(0.0);
                        found = true;
                    }
                }

                found.then_some(total as f32)
            }
        }

        fn reopen(&mut self) -> Option<()> {
            unsafe {
                if self.query != 0 {
                    let _ = PdhCloseQuery(self.query);
                    self.query = 0;
                }

                let mut query = 0isize;
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 || query == 0 {
                    self.counters.clear();
                    return None;
                }
                self.query = query;
                self.counters.clear();
                self.expanded_at = Instant::now();

                self.expand();

                if PdhCollectQueryData(query) != 0 {
                    return None;
                }
                Some(())
            }
        }

        /// Expande o curinga `(*)` e registra um contador por motor gráfico.
        fn expand(&mut self) {
            let mut size = 0u32;
            unsafe {
                let status = PdhExpandWildCardPathW(
                    PCWSTR::null(),
                    PCWSTR::from_raw(self.path.as_ptr()),
                    PWSTR::null(),
                    &mut size,
                    0,
                );
                if status != PDH_MORE_DATA || size == 0 {
                    return;
                }

                let mut buffer = vec![0u16; size as usize];
                let status = PdhExpandWildCardPathW(
                    PCWSTR::null(),
                    PCWSTR::from_raw(self.path.as_ptr()),
                    PWSTR::from_raw(buffer.as_mut_ptr()),
                    &mut size,
                    0,
                );
                if status != 0 {
                    return;
                }

                let mut index = 0usize;
                while index < buffer.len() {
                    let start = index;
                    while index < buffer.len() && buffer[index] != 0 {
                        index += 1;
                    }
                    if index == start {
                        break;
                    }

                    let mut counter = 0isize;
                    let path = PCWSTR::from_raw(buffer[start..].as_ptr());
                    if PdhAddEnglishCounterW(self.query, path, 0, &mut counter) == 0 {
                        self.counters.push(counter);
                    }
                    index += 1;
                }
            }
        }
    }

    impl Drop for GpuCounter {
        fn drop(&mut self) {
            if self.query != 0 {
                unsafe {
                    let _ = PdhCloseQuery(self.query);
                }
            }
        }
    }
}

/// Abre o diálogo "Salvar como" e grava o backup (JSON) escolhido pelo usuário.
/// Devolve o caminho salvo, ou `None` se o usuário cancelar.
#[tauri::command]
async fn export_backup(app: AppHandle, contents: String) -> Result<Option<String>, String> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("Backup do Pericles Widget", &["json"])
        .set_file_name("pericles-widget-backup.json")
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    std::fs::write(&path, contents).map_err(|error| error.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// Abre o diálogo de escolha de arquivo e devolve o conteúdo do backup.
/// Devolve `None` se o usuário cancelar.
#[tauri::command]
async fn import_backup(app: AppHandle) -> Result<Option<String>, String> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("Backup do Pericles Widget", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(DualScreenState::default())
        // O botão "Usar minha localização" do painel de clima precisa da
        // permissão de geolocalização. O pedido só acontece quando o usuário
        // clica no botão; as demais permissões continuam com o padrão do sistema.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Geolocation => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            set_second_screen,
            snap_widget_top_center,
            open_external,
            get_system_metrics,
            export_backup,
            import_backup
        ])
        .setup(|app| {
            // O coletor de métricas já começa aqui, em paralelo com a carga da
            // interface: assim a primeira leitura (mais lenta) não aparece como
            // espera no widget.
            metrics_store();
            // A janela principal é criada invisível (tauri.conf.json) para já
            // aparecer centralizada no topo da tela, sem "pular" de posição.
            if let Some(main) = app.get_webview_window("main") {
                if let Err(error) = place_at_top_center(&main) {
                    eprintln!("Não foi possível posicionar o widget no topo da tela: {error}");
                }
                main.show()?;
            }

            // Ícone na bandeja do sistema (ícones ocultos), em vez de botão na
            // barra de tarefas.
            let tray_menu = Menu::new(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            tray_menu.append(&quit_item)?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Fechar a janela principal encerra o aplicativo, mesmo que o widget
            // secundário ainda esteja aberto no outro monitor.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar Pericles Desktop Widget");
}
