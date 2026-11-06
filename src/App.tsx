import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { AlarmClock, Bell, CloudSun, Settings2, X, Plus, Check, Pause, Play, Volume2, LocateFixed, Search, Timer, StickyNote } from "lucide-react";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";

type Alarm = { id: string; time: string; label: string; enabled: boolean; repeat: boolean; lastFired?: string };
type Reminder = { id: string; title: string; due: string; done: boolean; repeat?: boolean; tag?: string };
type Weather = { temperature: number; apparent: number; humidity: number; code: number; city: string; forecast?: Array<{ date: string; code: number; max: number; min: number }> };
type Place = { name: string; admin1?: string; country?: string; latitude: number; longitude: number };
type CitySuggestion = Place & { id: string; label: string };
type Prefs = { opacity: number; alwaysOnTop: boolean; showOnDesktopOnly: boolean; launchAtLogin: boolean; dualMonitor: boolean; alarmVolume: number; alarmSound: string; notificationsEnabled: boolean; lockPosition: boolean; systemMetricsEnabled: boolean; metricsSelected: string[] };
type Panel = "alarm" | "reminder" | "weather" | "settings" | "focus" | "notes";
type SyncPayload = { from: string; key: string; value: unknown };

type GeocodingResult = { id?: number; name: string; admin1?: string; country?: string; latitude: number; longitude: number };
type Coordinates = { latitude: number; longitude: number };
type IpLocation = Coordinates & { city?: string; region?: string };

const defaultPrefs: Prefs = { opacity: 88, alwaysOnTop: false, showOnDesktopOnly: false, launchAtLogin: false, dualMonitor: false, alarmVolume: 70, alarmSound: "classic", notificationsEnabled: true, lockPosition: true, systemMetricsEnabled: false, metricsSelected: ["cpu", "memory", "network", "battery", "gpu"] };
const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const placeLabel = (place: Place) => [place.name, place.admin1].filter(Boolean).join(", ");
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes.toFixed(0)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
};
const diskUsagePercent = (disk: { total: number; available: number }) => disk.total > 0 ? ((disk.total - disk.available) / disk.total) * 100 : 0;

const load = <T,>(key: string, fallback: T): T => {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const save = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
const weatherText = (code: number) => code === 0 ? "Céu limpo" : [1,2,3].includes(code) ? "Parcialmente nublado" : [45,48].includes(code) ? "Neblina" : [51,53,55,56,57].includes(code) ? "Garoa" : [61,63,65,66,67,80,81,82].includes(code) ? "Chuva" : [71,73,75,77,85,86].includes(code) ? "Neve" : [95,96,99].includes(code) ? "Trovoadas" : "Condição variável";
const dateLabel = () => new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

// Busca cidades no serviço de geocodificação do Open-Meteo e devolve as opções
// já formatadas para a lista de sugestões (nome + estado/país).
async function searchCities(query: string, signal?: AbortSignal): Promise<CitySuggestion[]> {
  const response = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=pt&format=json`,
    { signal },
  );
  if (!response.ok) throw new Error("Não foi possível buscar cidades.");
  const data = await response.json() as { results?: GeocodingResult[] };
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map(result => ({
    id: String(result.id ?? `${result.latitude},${result.longitude},${result.name}`),
    name: result.name,
    admin1: result.admin1,
    country: result.country,
    latitude: result.latitude,
    longitude: result.longitude,
    label: [result.name, result.admin1].filter(Boolean).join(", "),
  }));
}

// Posição aproximada pela rede (funciona mesmo quando o Windows/WebView nega o
// GPS). Serve de reserva para o botão "Usar minha localização".
async function ipPosition(): Promise<IpLocation> {
  const response = await fetch("https://ipwho.is/");
  if (!response.ok) throw new Error("Não foi possível detectar sua localização.");
  const data = await response.json() as Partial<IpLocation> & { success?: boolean };
  if (data.success === false || typeof data.latitude !== "number" || typeof data.longitude !== "number") {
    throw new Error("Não foi possível detectar sua localização.");
  }
  return { latitude: data.latitude, longitude: data.longitude, city: data.city, region: data.region };
}

function browserPosition(): Promise<Coordinates> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Localização não disponível neste computador."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      error => reject(new Error(error.code === error.PERMISSION_DENIED ? "Permissão de localização negada." : "Não foi possível obter sua localização.")),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

// Converte as coordenadas em um nome de cidade legível.
async function reverseGeocode({ latitude, longitude }: Coordinates): Promise<Place> {
  const response = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=pt`);
  if (!response.ok) throw new Error("Não foi possível identificar a cidade.");
  const data = await response.json() as { city?: string; locality?: string; principalSubdivision?: string; countryName?: string };
  const name = (data.city || data.locality || data.principalSubdivision || "").trim();
  if (!name) throw new Error("Não foi possível identificar a cidade.");
  return { name, admin1: data.principalSubdivision, country: data.countryName, latitude, longitude };
}

export default function App() {
  const currentWindow = useMemo(() => getCurrentWindow(), []);
  const windowLabel = currentWindow.label;
  const isSecondary = windowLabel === "secondary";
  const appRef = useRef<HTMLElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const soundTimerRef = useRef<number | null>(null);
  const originalWindowSize = useRef({ width: 790, height: 204 });
  const autostartReady = useRef(false);
  const autostartApplied = useRef<boolean | null>(null);
  const skipBroadcast = useRef<Set<string>>(new Set());
  const [now, setNow] = useState(new Date());
  const [alarms, setAlarms] = useState<Alarm[]>(() => load("pdw-alarms", []));
  const [reminders, setReminders] = useState<Reminder[]>(() => load("pdw-reminders", []));
  const isDraggingRef = useRef(false);
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const loaded = load<Partial<Prefs>>("pdw-prefs", {});
    const merged = { ...defaultPrefs, ...loaded };
    if (Array.isArray(loaded.metricsSelected) && loaded.metricsSelected.join(",") === "cpu,memory,network") {
      merged.metricsSelected = defaultPrefs.metricsSelected;
    }
    if (!Array.isArray(merged.metricsSelected)) merged.metricsSelected = defaultPrefs.metricsSelected;
    return merged;
  });
  const [weather, setWeather] = useState<Weather | null>(() => load<Weather | null>("pdw-weather", null));
  const [city, setCity] = useState(() => load("pdw-city", "Recife"));
  const [place, setPlace] = useState<Place | null>(() => load<Place | null>("pdw-place", null));
  const [weatherError, setWeatherError] = useState("");
  const [suggestions, setSuggestions] = useState<CitySuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [searchingCity, setSearchingCity] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const cityRef = useRef(city);
  const placeRef = useRef(place);
  const reloadWeatherAfterSync = useRef(false);
  const [panel, setPanel] = useState<Panel | null>(null);
const [editingReminderId, setEditingReminderId] = useState<string | null>(null);
const [editingReminderValue, setEditingReminderValue] = useState<{ title: string; due: string }>({ title: "", due: "" });
  const [alarmTime, setAlarmTime] = useState("14:00");
  const [alarmLabel, setAlarmLabel] = useState("");
  const [alarmRepeat, setAlarmRepeat] = useState(false);
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderDue, setReminderDue] = useState("");
  const [reminderRepeat, setReminderRepeat] = useState(false);
  const [reminderTag, setReminderTag] = useState("");
  const [reminderFilter, setReminderFilter] = useState<"all" | "pending" | "done">("all");
  const [reminderSearch, setReminderSearch] = useState("");
  const [focusWork, setFocusWork] = useState(() => load<number>("pdw-focus-work", 25));
  const [focusBreak, setFocusBreak] = useState(() => load<number>("pdw-focus-break", 5));
  const [focusMode, setFocusMode] = useState<"focus" | "break">("focus");
  const [focusRemaining, setFocusRemaining] = useState(() => load<number>("pdw-focus-work", 25) * 60);
  const [focusRunning, setFocusRunning] = useState(false);
  const [focusSessions, setFocusSessions] = useState(() => load<number>("pdw-focus-sessions", 0));
  const [stopwatchRunning, setStopwatchRunning] = useState(false);
  const [stopwatchElapsed, setStopwatchElapsed] = useState(0);
  const [stopwatchLaps, setStopwatchLaps] = useState<number[]>([]);
  const [productivityTab, setProductivityTab] = useState<"pomodoro" | "stopwatch" | "notes" | "shortcuts">("pomodoro");
  type QuickNote = { id: string; text: string; createdAt: number };
  type QuickShortcut = { id: string; label: string; url: string };
  const [notes, setNotes] = useState<QuickNote[]>(() => load<QuickNote[]>("pdw-notes", []));
  const [noteDraft, setNoteDraft] = useState("");
  const [shortcuts, setShortcuts] = useState<QuickShortcut[]>(() => load<QuickShortcut[]>("pdw-shortcuts", []));
  const [shortcutLabel, setShortcutLabel] = useState("");
  const [shortcutUrl, setShortcutUrl] = useState("");
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [transparencyModalOpen, setTransparencyModalOpen] = useState(false);
  const [volumeModalOpen, setVolumeModalOpen] = useState(false);
  const [soundModalOpen, setSoundModalOpen] = useState(false);
  const [metricsModalOpen, setMetricsModalOpen] = useState(false);  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [snooze, setSnooze] = useState<{label:string; until:number} | null>(null);
  const [ringing, setRinging] = useState<{label:string} | null>(null);
  const [dualScreenError, setDualScreenError] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [restoreData, setRestoreData] = useState<Record<string, unknown> | null>(null);

  // Backup: lê todas as chaves "pdw-*" do armazenamento local e salva em um
  // arquivo JSON escolhido pelo usuário (diálogo nativo do Windows).
  const exportBackup = async () => {
    const data: Record<string, unknown> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("pdw-")) data[key] = load<unknown>(key, null);
    }
    try {
      const path = await invoke<string | null>("export_backup", {
        contents: JSON.stringify({ app: "pericles-desktop-widget", version: 1, exportedAt: new Date().toISOString(), data }, null, 2),
      });
      setBackupMessage(path ? `Backup salvo em ${path}` : "");
    } catch (error) {
      setBackupMessage(errorMessage(error, "Não foi possível salvar o backup."));
    }
  };

  // Restauração em duas etapas: escolher o arquivo e depois confirmar, para não
  // substituir os dados atuais por engano.
  const chooseBackup = async () => {
    try {
      const contents = await invoke<string | null>("import_backup");
      if (!contents) return;
      const parsed = JSON.parse(contents) as { app?: string; data?: Record<string, unknown> };
      if (parsed.app !== "pericles-desktop-widget" || !parsed.data || typeof parsed.data !== "object") {
        throw new Error("Este arquivo não é um backup do Pericles Desktop Widget.");
      }
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed.data)) {
        if (key.startsWith("pdw-")) data[key] = value;
      }
      setRestoreData(data);
      setBackupMessage("");
    } catch (error) {
      setBackupMessage(errorMessage(error, "Não foi possível ler o backup."));
    }
  };

  const applyBackup = async () => {
    if (!restoreData) return;
    for (const [key, value] of Object.entries(restoreData)) save(key, value);
    setRestoreData(null);
    // Avisa a outra janela (segunda tela) para recarregar com os dados restaurados.
    await emit("pdw:restore").catch(() => undefined);
    window.location.reload();
  };
const [systemMetrics, setSystemMetrics] = useState<{ cpu: number; memUsed: number; memTotal: number; rx: number; tx: number; battery: number | null; gpuName: string | null; gpuUsage: number | null; gpuTemp: number | null; disks: Array<{ name: string; total: number; available: number }> } | null>(null);
const prevNetRef = useRef<{ rx: number; tx: number; time: number } | null>(null);
const metricsFetchingRef = useRef(false);
const [appVersion, setAppVersion] = useState("1.0.0");

  useEffect(() => {
    let active = true;
    const currentWindow = getCurrentWindow();
    void (async () => {
      try {
        const [size, scale] = await Promise.all([currentWindow.innerSize(), currentWindow.scaleFactor()]);
        if (!active) return;
        originalWindowSize.current = { width: Math.round(size.width / scale), height: Math.round(size.height / scale) };
      } catch (error) {
        console.warn("Não foi possível detectar o tamanho inicial da janela.", error);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void getVersion()
      .then((version) => { if (active) setAppVersion(version); })
      .catch((error) => { console.warn("Não foi possível obter a versão do aplicativo.", error); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    const appElement = appRef.current;
    if (!appElement) return;

    let frame = 0;
    let lastSize = "";
    const resizeToFit = () => {
      if (isDraggingRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (isDraggingRef.current) return;
          const width = originalWindowSize.current.width;
          const height = Math.max(1, Math.ceil(appElement.scrollHeight));
          const key = `${width}x${height}`;
          if (key === lastSize) return;
          lastSize = key;
          void currentWindow.setSize(new LogicalSize(width, height)).catch(error => {
            console.warn("Não foi possível ajustar o widget.", error);
          });
        });
      });
    };

    resizeToFit();
    const observer = new ResizeObserver(resizeToFit);
    observer.observe(appElement);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [panel, alarms.length, reminders.length, snooze, ringing, weather, weatherError, prefs.systemMetricsEnabled]);

  useEffect(() => {
    const clear = () => { isDraggingRef.current = false; };
    window.addEventListener("mouseup", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("mouseup", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => {
    if (isSecondary) return;
    let disposed = false;
    void (async () => {
      try {
        await register("CommandOrControl+Shift+H", async () => {
          try {
            const win = getCurrentWindow();
            const visible = await win.isVisible();
            if (visible) await win.hide();
            else { await win.show(); await win.setFocus(); }
          } catch (e) { console.warn(e); }
        });
        await register("CommandOrControl+Shift+S", async () => {
          if (ringing) snoozeAlarm();
        });
      } catch (e) { console.warn("Não foi possível registrar atalhos globais.", e); }
    })();
    return () => {
      disposed = true;
      void unregister("CommandOrControl+Shift+H").catch(() => undefined);
      void unregister("CommandOrControl+Shift+S").catch(() => undefined);
    };
  }, [isSecondary, ringing]);
  // Recarrega a janela quando um backup é restaurado (na janela atual ou na
  // segunda tela), para todos os dados virem do armazenamento já restaurado.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen("pdw:restore", () => window.location.reload()).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, []);
  useEffect(() => { persistAndSync("pdw-reminders", reminders); }, [reminders]);
  useEffect(() => { save("pdw-focus-work", focusWork); }, [focusWork]);
  useEffect(() => { save("pdw-focus-break", focusBreak); }, [focusBreak]);
  useEffect(() => { save("pdw-focus-sessions", focusSessions); }, [focusSessions]);
  useEffect(() => { save("pdw-notes", notes); }, [notes]);
  useEffect(() => { save("pdw-shortcuts", shortcuts); }, [shortcuts]);
  useEffect(() => { persistAndSync("pdw-prefs", prefs); }, [prefs]);
  useEffect(() => { persistAndSync("pdw-city", city); }, [city]);
  useEffect(() => { persistAndSync("pdw-place", place); }, [place]);
  useEffect(() => { cityRef.current = city; }, [city]);
  useEffect(() => { placeRef.current = place; }, [place]);

  // Mantém as duas janelas (principal e secundária) com os mesmos dados.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<SyncPayload>("pdw:sync", ({ payload }) => {
      if (payload.from === windowLabel) return;
      if (payload.key === "pdw-alarms") {
        setAlarms(prev => {
          if (sameJSON(prev, payload.value)) return prev;
          skipBroadcast.current.add("pdw-alarms");
          return payload.value as Alarm[];
        });
      } else if (payload.key === "pdw-reminders") {
        setReminders(prev => {
          if (sameJSON(prev, payload.value)) return prev;
          skipBroadcast.current.add("pdw-reminders");
          return payload.value as Reminder[];
        });
      } else if (payload.key === "pdw-prefs") {
        setPrefs(prev => {
          const loaded = payload.value as Partial<Prefs>;
          const next = { ...defaultPrefs, ...loaded };
          if (Array.isArray(loaded.metricsSelected) && loaded.metricsSelected.join(",") === "cpu,memory,network") {
            next.metricsSelected = defaultPrefs.metricsSelected;
          }
          if (!Array.isArray(next.metricsSelected)) next.metricsSelected = defaultPrefs.metricsSelected;
          if (sameJSON(prev, next)) return prev;
          skipBroadcast.current.add("pdw-prefs");
          return next;
        });
      } else if (payload.key === "pdw-city") {
        setCity(prev => {
          if (prev === payload.value) return prev;
          skipBroadcast.current.add("pdw-city");
          reloadWeatherAfterSync.current = true;
          return payload.value as string;
        });
      } else if (payload.key === "pdw-place") {
        setPlace(prev => {
          const next = (payload.value ?? null) as Place | null;
          if (sameJSON(prev, next)) return prev;
          skipBroadcast.current.add("pdw-place");
          reloadWeatherAfterSync.current = true;
          return next;
        });
      }
    }).then(fn => {
      if (disposed) { fn(); return; }
      unlisten = fn;
      // A janela secundária pede o estado atual assim que fica pronta.
      if (isSecondary) void emit("pdw:sync-request", {}).catch(() => undefined);
    }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [windowLabel, isSecondary]);

  useEffect(() => {
    if (isSecondary) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen("pdw:sync-request", () => {
      (["pdw-alarms", "pdw-reminders", "pdw-prefs", "pdw-city", "pdw-place"] as const).forEach(key => {
        const value = load<unknown>(key, null);
        if (value !== null) void emit("pdw:sync", { from: windowLabel, key, value }).catch(() => undefined);
      });
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [windowLabel, isSecondary]);

  // Liga as preferências de janela aos comandos nativos do Tauri. Cada janela
  // (principal e secundária) aplica o estado às próprias configurações — a
  // secundária recebe as mesmas preferências pela sincronização. "Sobre outros
  // programas" tem prioridade sobre o modo área de trabalho.
  useEffect(() => {
    void currentWindow.setAlwaysOnTop(prefs.alwaysOnTop).catch(error => {
      console.warn("Não foi possível alterar o modo 'sobre outros programas'.", error);
    });
    void currentWindow
      .setAlwaysOnBottom(prefs.showOnDesktopOnly && !prefs.alwaysOnTop)
      .catch(error => {
        console.warn("Não foi possível alterar o modo área de trabalho.", error);
      });
  }, [currentWindow, prefs.alwaysOnTop, prefs.showOnDesktopOnly]);

  // Trava a posição do widget: quando ativo, fixa a janela no topo centralizado
  // do monitor em que ela deve ficar e impede o arraste.
  // A conta é feita no backend (`snap_widget_top_center`), que usa a área útil
  // do monitor. Fazer isso aqui exigiria somar a origem do monitor às
  // coordenadas — sem isso, a janela secundária era trazida para o primeiro
  // monitor, em cima da principal.
  useEffect(() => {
    if (!prefs.lockPosition) return;
    void invoke("snap_widget_top_center", { label: windowLabel }).catch(error => {
      console.warn("Não foi possível travar a posição do widget.", error);
    });
  }, [prefs.lockPosition, windowLabel]);

  // A inicialização automática é controlada apenas pela janela principal, que
  // lê o estado real do sistema antes de aplicar qualquer alteração.
  useEffect(() => {
    if (isSecondary) return;
    let active = true;
    void (async () => {
      try {
        const enabled = await isAutostartEnabled();
        if (!active) return;
        autostartApplied.current = enabled;
        setPrefs(prev => prev.launchAtLogin === enabled ? prev : { ...prev, launchAtLogin: enabled });
      } catch (error) {
        console.warn("Não foi possível consultar a inicialização automática.", error);
      } finally {
        if (active) autostartReady.current = true;
      }
    })();
    return () => { active = false; };
  }, [isSecondary]);

  useEffect(() => {
    if (isSecondary) return;
    if (!autostartReady.current || autostartApplied.current === prefs.launchAtLogin) return;
    const desired = prefs.launchAtLogin;
    autostartApplied.current = desired;
    void (async () => {
      try {
        if (desired) await enableAutostart();
        else await disableAutostart();
      } catch (error) {
        console.warn("Não foi possível alterar a inicialização automática.", error);
        autostartApplied.current = !desired;
        setPrefs(prev => ({ ...prev, launchAtLogin: !desired }));
      }
    })();
  }, [isSecondary, prefs.launchAtLogin]);

  // A janela principal controla a existência do widget secundário no outro
  // monitor. Ele nasce centralizado no topo da tela, igual à janela principal.
  useEffect(() => {
    if (isSecondary) return;
    if (!prefs.dualMonitor) {
      void invoke("set_second_screen", { visible: false }).catch(() => undefined);
      return;
    }
    void invoke<boolean>("set_second_screen", { visible: true })
      .then(() => setDualScreenError(""))
      .catch((error: unknown) => {
        setDualScreenError(typeof error === "string" ? error : "Não foi possível abrir o widget na segunda tela.");
        updatePrefs({ dualMonitor: false });
      });
  }, [prefs.dualMonitor, isSecondary]);

  const nextAlarm = useMemo(() => alarms.filter(a => a.enabled).sort((a,b) => a.time.localeCompare(b.time))[0], [alarms]);
  const pendingReminders = reminders.filter(r => !r.done).length;
  const filteredReminders = reminders.filter(r => {
    if (reminderFilter === "pending" && r.done) return false;
    if (reminderFilter === "done" && !r.done) return false;
    const q = reminderSearch.trim().toLowerCase();
    if (q && !r.title.toLowerCase().includes(q) && !(r.tag || "").toLowerCase().includes(q)) return false;
    return true;
  });

  function getAudioContext() {
    if (!audioContextRef.current) {
      const AudioContextConstructor = window.AudioContext;
      if (!AudioContextConstructor) return null;
      audioContextRef.current = new AudioContextConstructor();
    }
    if (audioContextRef.current.state === "suspended") void audioContextRef.current.resume();
    return audioContextRef.current;
  }

  function playAlarmTone() {
    const context = getAudioContext();
    if (!context) return;
    const start = context.currentTime;
    const volume = Math.max(0, Math.min(100, prefs.alarmVolume ?? 70)) / 100;
    const peak = 0.22 * volume;
    const soundPresets: Record<string, number[]> = {
      classic: [880, 660],
      beep: [1000],
      bell: [660, 880, 1100],
      digital: [523, 659, 784],
      soft: [440, 554],
    };
    const frequencies = soundPresets[prefs.alarmSound] ?? soundPresets.classic;
    frequencies.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = start + index * 0.22;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), at + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.19);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.2);
    });
  }

  function startAlarmSound() {
    stopAlarmSound();
    playAlarmTone();
    soundTimerRef.current = window.setInterval(playAlarmTone, 900);
  }

  function stopAlarmSound() {
    if (soundTimerRef.current !== null) {
      window.clearInterval(soundTimerRef.current);
      soundTimerRef.current = null;
    }
  }

  function dismissAlarm() {
    stopAlarmSound();
    if (ringing?.label?.startsWith("Lembrete: ")) {
      const title = ringing.label.replace(/^Lembrete: /, "");
      setReminders(old => old.filter(r => r.title !== title));
    }
    setRinging(null);
    setSnooze(null);
    if (isSecondary) void emit("pdw:ringing-action", { action: "dismiss" }).catch(() => undefined);
  }

  function snoozeAlarm() {
    if (!ringing) return;
    stopAlarmSound();
    setSnooze({ label: ringing.label, until: Date.now() + 5 * 60 * 1000 });
    setRinging(null);
    if (isSecondary) void emit("pdw:ringing-action", { action: "snooze" }).catch(() => undefined);
  }

  function broadcastSync(key: string, value: unknown) {
    void emit("pdw:sync", { from: windowLabel, key, value }).catch(() => undefined);
  }

  // Persiste localmente e avisa a outra janela. Alterações que acabaram de
  // chegar pela sincronização não são reenviadas, evitando que as duas janelas
  // fiquem em loop sobrescrevendo o estado uma da outra.
  function persistAndSync(key: string, value: unknown) {
    save(key, value);
    if (skipBroadcast.current.delete(key)) return;
    broadcastSync(key, value);
  }

  // Apenas a janela principal dispara alarmes, notificações e o som; a secundária
  // apenas espelha o aviso e envia as ações (parar/adiar) para a principal.
  useEffect(() => {
    if (isSecondary) return;
    void emit("pdw:ringing", { label: ringing?.label ?? null }).catch(() => undefined);
  }, [ringing, isSecondary]);

  useEffect(() => {
    if (!isSecondary) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<{ label: string | null }>("pdw:ringing", ({ payload }) => {
      setRinging(payload.label ? { label: payload.label } : null);
    }).then(fn => {
      if (disposed) { fn(); return; }
      unlisten = fn;
      // Avisa a janela principal que está pronta para receber o estado atual.
      void emit("pdw:ringing-request", {}).catch(() => undefined);
    }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [isSecondary]);

  useEffect(() => {
    if (isSecondary) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen("pdw:ringing-request", () => {
      void emit("pdw:ringing", { label: ringing?.label ?? null }).catch(() => undefined);
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [ringing, isSecondary]);

  useEffect(() => {
    if (isSecondary) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<{ action: "dismiss" | "snooze" }>("pdw:ringing-action", ({ payload }) => {
      if (payload.action === "dismiss") dismissAlarm();
      else snoozeAlarm();
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSecondary, ringing]);

  useEffect(() => () => {
    if (soundTimerRef.current !== null) window.clearInterval(soundTimerRef.current);
    void audioContextRef.current?.close();
  }, []);

  async function notify(title: string, body: string) {
    if (!prefs.notificationsEnabled) return;
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title, body });
    } catch { window.alert(`${title}\n${body}`); }
  }

  useEffect(() => {
    if (isSecondary) return;
    const current = new Date();
    const key = `${current.getFullYear()}-${current.getMonth()}-${current.getDate()}-${current.getHours()}:${current.getMinutes()}`;
    setAlarms(prev => prev.map(a => {
      if (!a.enabled || a.time !== `${String(current.getHours()).padStart(2,"0")}:${String(current.getMinutes()).padStart(2,"0")}` || a.lastFired === key) return a;
      void notify(`Alarme: ${a.label}`, "Está na hora! O alarme está tocando.");
      setRinging({ label: a.label });
      startAlarmSound();
      return { ...a, lastFired: key, enabled: a.repeat ? true : false };
    }));
    reminders.forEach(r => {
      if (!r.done && r.due && new Date(r.due).getTime() <= Date.now() && new Date(r.due).getTime() > Date.now() - 1500) {
        void notify("Lembrete", r.title);
        setRinging({ label: `Lembrete: ${r.title}` });
        startAlarmSound();
        if (r.repeat) {
          const nextDue = new Date(new Date(r.due).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
          setReminders(old => old.map(x => x.id === r.id ? { ...x, due: nextDue } : x));
        }
      }
    });
  // Alarm matching is checked once per minute; the snooze timer is checked on clock ticks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now.getMinutes(), isSecondary]);

  useEffect(() => {
    if (isSecondary) return;
    if (snooze && Date.now() >= snooze.until) {
      setRinging({ label: snooze.label });
      startAlarmSound();
      void notify(`Alarme adiado: ${snooze.label}`, "O tempo de adiamento terminou.");
      setSnooze(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, snooze, isSecondary]);

  async function loadWeather(target: Place) {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${target.latitude}&longitude=${target.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5&timezone=auto`);
    if (!response.ok) throw new Error("Serviço meteorológico indisponível.");
    const data = await response.json() as { current: { temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; weather_code: number }; daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[] } };
    const forecast = Array.isArray(data.daily?.time) ? data.daily!.time.map((date, index) => ({
      date,
      code: data.daily!.weather_code[index],
      max: data.daily!.temperature_2m_max[index],
      min: data.daily!.temperature_2m_min[index],
    })) : undefined;
    const nextWeather: Weather = {
      temperature: data.current.temperature_2m,
      apparent: data.current.apparent_temperature,
      humidity: data.current.relative_humidity_2m,
      code: data.current.weather_code,
      city: placeLabel(target),
      forecast,
    };
    setWeather(nextWeather);
    save("pdw-weather", nextWeather);
  }

  // Atualiza a previsão. Usa as coordenadas da cidade escolhida na lista; se o
  // texto digitado não corresponder a ela, busca a primeira cidade encontrada.
  async function fetchWeather(target?: Place) {
    setWeatherError("");
    setLocationError("");
    try {
      const typed = cityRef.current.trim();
      const saved = placeRef.current;
      let selected = target ?? (saved && placeLabel(saved) === typed ? saved : null);
      if (!selected) {
        if (!typed) throw new Error("Digite o nome de uma cidade.");
        const found = await searchCities(typed);
        selected = found[0] ?? null;
        if (!selected) throw new Error("Cidade não encontrada. Tente outro nome.");
        const chosen: Place = { name: selected.name, admin1: selected.admin1, country: selected.country, latitude: selected.latitude, longitude: selected.longitude };
        setPlace(chosen);
        setCity(placeLabel(chosen));
        setSuggestions([]);
        setShowSuggestions(false);
      }
      await loadWeather(selected);
    } catch (e) {
      const offline = !navigator.onLine;
      const cached = load<Weather | null>("pdw-weather", null);
      if (cached) setWeather(cached);
      setWeatherError(offline ? "Sem conexão com a internet — exibindo último clima salvo." : (e instanceof Error ? e.message : "Erro ao consultar o tempo."));
    }
  }

  // Aplica uma cidade escolhida (sugestão ou localização atual) e já carrega o clima.
  async function applyPlace(selected: Place) {
    setPlace(selected);
    setCity(placeLabel(selected));
    setSuggestions([]);
    setShowSuggestions(false);
    setActiveSuggestion(-1);
    setLocationError("");
    setWeatherError("");
    try { await loadWeather(selected); }
    catch (e) { setWeatherError(errorMessage(e, "Erro ao consultar o tempo.")); }
  }

  // Efeito de digitação: consulta o serviço de cidades e monta a lista de
  // opções exibida logo abaixo do campo.
  useEffect(() => {
    const query = city.trim();
    const selected = place;
    if (selected && placeLabel(selected) === query) {
      setSuggestions([]);
      setShowSuggestions(false);
      setSearchingCity(false);
      return;
    }
    if (query.length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      setSearchingCity(false);
      return;
    }
    const controller = new AbortController();
    setSearchingCity(true);
    const timer = window.setTimeout(() => {
      void searchCities(query, controller.signal)
        .then(found => {
          if (controller.signal.aborted) return;
          setSuggestions(found);
          setShowSuggestions(found.length > 0);
          setActiveSuggestion(found.length > 0 ? 0 : -1);
        })
        .catch(() => undefined)
        .finally(() => { if (!controller.signal.aborted) setSearchingCity(false); });
    }, 320);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      setSearchingCity(false);
    };
  }, [city, place]);

  function chooseSuggestion(suggestion: CitySuggestion) {
    void applyPlace({
      name: suggestion.name,
      admin1: suggestion.admin1,
      country: suggestion.country,
      latitude: suggestion.latitude,
      longitude: suggestion.longitude,
    });
  }

  function handleCityKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!showSuggestions || suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion(index => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion(index => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === "Enter") {
      if (activeSuggestion >= 0) {
        event.preventDefault();
        chooseSuggestion(suggestions[activeSuggestion]);
      }
    } else if (event.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  // Usa a localização do computador. Se o Windows negar o acesso, cai para a
  // localização aproximada pela rede, e por fim identifica a cidade.
  async function useMyLocation() {
    setLocating(true);
    setLocationError("");
    setWeatherError("");
    try {
      let coordinates: Coordinates;
      let networkCity: string | undefined;
      let networkRegion: string | undefined;
      try {
        coordinates = await browserPosition();
      } catch {
        const network = await ipPosition();
        coordinates = { latitude: network.latitude, longitude: network.longitude };
        networkCity = network.city;
        networkRegion = network.region;
      }

      let found: Place | null = null;
      try { found = await reverseGeocode(coordinates); } catch { found = null; }

      if (!found && networkCity) {
        const matches = await searchCities(networkCity).catch(() => [] as CitySuggestion[]);
        const match = matches.find(item => item.name.toLowerCase() === networkCity!.toLowerCase()) ?? matches[0];
        if (match) {
          found = { name: match.name, admin1: match.admin1, country: match.country, latitude: match.latitude, longitude: match.longitude };
        }
      }

      if (!found) {
        const fallbackName = networkCity || "Minha localização";
        found = { name: fallbackName, admin1: networkRegion, latitude: coordinates.latitude, longitude: coordinates.longitude };
      }

      await applyPlace(found);
    } catch (e) {
      setLocationError(errorMessage(e, "Não foi possível obter sua localização. Digite a cidade manualmente."));
    } finally {
      setLocating(false);
    }
  }

  useEffect(() => { void fetchWeather(); const id = window.setInterval(() => void fetchWeather(), 30 * 60 * 1000); return () => clearInterval(id); }, []);

  // Quando a cidade muda na outra janela, a previsão também é atualizada aqui.
  // Usa apenas as coordenadas já recebidas: nunca reescreve o texto digitado
  // (o que atrapalharia quem está digitando na outra janela).
  useEffect(() => {
    if (!reloadWeatherAfterSync.current) return;
    reloadWeatherAfterSync.current = false;
    const selected = placeRef.current;
    if (!selected || placeLabel(selected) !== cityRef.current.trim()) return;
    setWeatherError("");
    void loadWeather(selected).catch(e => setWeatherError(errorMessage(e, "Erro ao consultar o tempo.")));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, place]);

  function addAlarm(e: React.FormEvent) {
    e.preventDefault();
    if (!alarmLabel.trim()) return;
    getAudioContext();
    setAlarms(old => [...old, { id: crypto.randomUUID(), time: alarmTime, label: alarmLabel.trim(), enabled: true, repeat: alarmRepeat }]);
    setAlarmLabel("");
  }
  function addReminder(e: React.FormEvent) {
    e.preventDefault();
    if (!reminderTitle.trim()) return;
    setReminders(old => [...old, { id: crypto.randomUUID(), title: reminderTitle.trim(), due: reminderDue, done: false, repeat: reminderRepeat, tag: reminderTag.trim() || undefined }]);
    setReminderTitle(""); setReminderDue(""); setReminderRepeat(false); setReminderTag("");
  }
  function updatePrefs(patch: Partial<Prefs>) { setPrefs(old => ({ ...old, ...patch })); }
  function togglePanel(next: Panel) { setPanel(current => current === next ? null : next); }

  const formatFocusTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  // Timer Pomodoro/foco: conta regressiva e alterna entre foco e pausa.
  useEffect(() => {
    if (!focusRunning) return;
    const id = window.setInterval(() => {
      setFocusRemaining(prev => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [focusRunning]);

  useEffect(() => {
    if (!focusRunning || focusRemaining > 0) return;
    // Concluiu a etapa atual.
    setFocusRunning(false);
    if (focusMode === "focus") {
      setFocusSessions(n => n + 1);
      setFocusMode("break");
      setFocusRemaining(focusBreak * 60);
      void notify("Pomodoro", "Tempo de foco concluído. Hora da pausa!");
    } else {
      setFocusMode("focus");
      setFocusRemaining(focusWork * 60);
      void notify("Pomodoro", "Pausa concluída. Hora de focar!");
    }
    getAudioContext();
    setRinging({ label: focusMode === "focus" ? "Pausa do Pomodoro" : "Foco do Pomodoro" });
    startAlarmSound();
    window.setTimeout(() => { stopAlarmSound(); setRinging(null); }, 1500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRemaining, focusRunning]);

  useEffect(() => {
    if (focusRunning) return;
    setFocusRemaining((focusMode === "focus" ? focusWork : focusBreak) * 60);
  }, [focusWork, focusBreak, focusMode, focusRunning]);

  // Cronômetro: conta progressiva.
  useEffect(() => {
    if (!stopwatchRunning) return;
    const start = Date.now() - stopwatchElapsed;
    const id = window.setInterval(() => {
      setStopwatchElapsed(Date.now() - start);
    }, 100);
    return () => window.clearInterval(id);
  }, [stopwatchRunning]);

  // Paleta de comandos: atalho global Ctrl+K / Cmd+K.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(v => !v);
      }
      if (event.key === "Escape") {
        if (commandOpen || shortcutsModalOpen || transparencyModalOpen || volumeModalOpen || soundModalOpen || metricsModalOpen) {
          setCommandOpen(false);
          setShortcutsModalOpen(false);
          setTransparencyModalOpen(false);
          setVolumeModalOpen(false);
          setSoundModalOpen(false);
          setMetricsModalOpen(false);
        } else if (panel) {
          setPanel(null);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [commandOpen, shortcutsModalOpen, transparencyModalOpen, volumeModalOpen, soundModalOpen, metricsModalOpen, panel]);

useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 250); return () => clearInterval(id); }, []);
  useEffect(() => {
    if (!prefs.systemMetricsEnabled) { setSystemMetrics(null); return; }
    // Recomeça a contagem: sem isso, ao reativar as métricas o primeiro cálculo
    // de rede compararia com um contador antigo e mostraria um pico falso.
    prevNetRef.current = null;
    let active = true;
    const fetchMetrics = async () => {
      if (metricsFetchingRef.current) return;
      metricsFetchingRef.current = true;
      try {
        const m = await invoke<{ cpu_usage: number; memory_used: number; memory_total: number; network_rx: number; network_tx: number; battery_percent: number | null; gpu_name: string | null; gpu_usage: number | null; gpu_temperature: number | null; disks: Array<{ name: string; total: number; available: number }> }>("get_system_metrics");
        if (!active) return;
        const now = Date.now();
        let rxRate = 0;
        let txRate = 0;
        if (prevNetRef.current) {
          const dt = (now - prevNetRef.current.time) / 1000;
          if (dt > 0) {
            rxRate = Math.max(0, (m.network_rx - prevNetRef.current.rx) / dt);
            txRate = Math.max(0, (m.network_tx - prevNetRef.current.tx) / dt);
          }
        }
        prevNetRef.current = { rx: m.network_rx, tx: m.network_tx, time: now };
        setSystemMetrics({ cpu: m.cpu_usage, memUsed: m.memory_used, memTotal: m.memory_total, rx: rxRate, tx: txRate, battery: m.battery_percent, gpuName: m.gpu_name, gpuUsage: m.gpu_usage, gpuTemp: m.gpu_temperature, disks: m.disks });
      } catch (e) { console.warn(e); }
      finally { metricsFetchingRef.current = false; }
    };
    void fetchMetrics();
    // O coletor do Rust mantém a amostra pronta, então consultar com mais
    // frequência é barato e os números aparecem/atualizam quase na hora.
    const id = window.setInterval(() => void fetchMetrics(), 2000);
    return () => { active = false; clearInterval(id); };
  }, [prefs.systemMetricsEnabled]);
  return <main ref={appRef} className="app" style={{ "--opacity": prefs.opacity / 100 } as React.CSSProperties}>
    <section className="widget" aria-label="Pericles Desktop Widget">
      <div className="drag-handle" data-tauri-drag-region={!prefs.lockPosition} style={{ cursor: prefs.lockPosition ? "default" : "move", pointerEvents: prefs.lockPosition ? "none" : "auto" }} title={prefs.lockPosition ? "Posição travada" : "Arraste para mover a janela"} onMouseDown={() => { isDraggingRef.current = true; }} onMouseUp={() => { isDraggingRef.current = false; }}><span className="live-dot"/> <span className="live-label">AO VIVO</span></div>
      <div className={`widget-main${prefs.systemMetricsEnabled ? " has-metrics" : ""}`}>
        <button className="clock-area" onClick={() => { setProductivityTab("stopwatch"); togglePanel("focus"); }} title="Abrir cronômetro">
          <span className="eyebrow">SEU TEMPO, SEU RITMO</span>
          <span className="clock">{now.toLocaleTimeString("pt-BR", { hour12: false })}</span>
          <span className="date">{dateLabel()}</span>
          {(focusRunning || stopwatchRunning) && <div style={{marginTop:"4px",display:"flex",gap:"12px",justifyContent:"center",flexWrap:"wrap",fontFamily:"DM Mono, Consolas, monospace",fontSize:"11px"}}>{focusRunning && <span>{focusMode === "focus" ? "Foco" : "Pausa"} {formatFocusTime(focusRemaining)}</span>}{stopwatchRunning && <span>Cronômetro {new Date(stopwatchElapsed).toISOString().substr(11, 11).replace(/^0/, "")}</span>}</div>}
        </button>
        <div className="divider"/>
        <button className="weather-area" onClick={() => togglePanel("weather")} title="Abrir previsão do tempo">
          <div className="weather-head">
            <CloudSun size={30} strokeWidth={1.6}/>
            <div className="weather-info">
              {weather ? <><span className="weather-line"><strong className="temperature">{Math.round(weather.temperature)}°C</strong> · {weatherText(weather.code)}</span><small>{weather.city}</small></> : <><span className="weather-line"><strong className="temperature">Tempo</strong></span><small>{weatherError || "Consultando..."}</small></>}
            </div>
          </div>
          {weather && <div className="weather-stats"><span>Sensação térmica <b>{Math.round(weather.apparent)}°C</b></span><span>Umidade <b>{weather.humidity}%</b></span></div>}
        </button>
        <div className="divider"/>
        <button className="next-area" onClick={(e) => { if ((e.target as HTMLElement)?.closest?.(".mini-count")) return; togglePanel("alarm"); }} title="Abrir alarmes">
          <span className="eyebrow"><AlarmClock size={13}/> PRÓXIMO ALARME</span>
          <strong className="next-time">{nextAlarm?.time || "— — : — —"}</strong>
          <span className="next-label">{nextAlarm?.label || "Nenhum alarme ativo"}</span>
          <span className="mini-count" role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); togglePanel("reminder"); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePanel("reminder"); } }}><Bell size={12}/> {pendingReminders} lembrete(s) pendente(s)</span>
        </button>
        {prefs.systemMetricsEnabled && <>
          <div className="divider"/>
          <button className="metrics-area" title="Métricas">
            {systemMetrics ? <>
                {(prefs.metricsSelected || []).includes("cpu") && <span className="metrics-line">CPU <b>{systemMetrics.cpu.toFixed(0)}%</b></span>}
                {(prefs.metricsSelected || []).includes("memory") && <span className="metrics-line">RAM <b>{(systemMetrics.memUsed/1024/1024/1024).toFixed(1)}/{(systemMetrics.memTotal/1024/1024/1024).toFixed(1)}GB</b></span>}
                {(prefs.metricsSelected || []).includes("network") && <span className="metrics-line">Rede <b>↓{formatBytes(systemMetrics.rx)}/s ↑{formatBytes(systemMetrics.tx)}/s</b></span>}
                {(prefs.metricsSelected || []).includes("battery") && systemMetrics.battery !== null && <span className="metrics-line">Bat <b>{systemMetrics.battery.toFixed(0)}%</b></span>}
                {(prefs.metricsSelected || []).includes("gpu") && (systemMetrics.gpuUsage !== null || systemMetrics.gpuName !== null) && <span className="metrics-line">GPU <b>{systemMetrics.gpuUsage !== null ? `${systemMetrics.gpuUsage.toFixed(0)}%` : "—"}{systemMetrics.gpuTemp !== null ? ` (${systemMetrics.gpuTemp}°C)` : ""}</b></span>}
                {systemMetrics.disks.map((disk, index) => (prefs.metricsSelected || []).includes("disk:" + index) ? <span key={"disk-" + index} className="metrics-line">DISCO {index} <b>{diskUsagePercent(disk).toFixed(0)}% ({(disk.available/1024/1024/1024).toFixed(1)}/{(disk.total/1024/1024/1024).toFixed(1)}GB)</b></span> : null)}
              </> : <span className="metrics-line metrics-loading">Carregando…</span>}
            </button>
          </>}
      </div>
      <div className="widget-footer">
        <span>DESKTOP WIDGET <span className="footer-dot">/</span> V{appVersion}</span>
        <button onClick={() => togglePanel("settings")} aria-label="Configurações"><Settings2 size={15}/></button>
<button onClick={() => togglePanel("notes")} aria-label="Notas"><StickyNote size={15}/></button>
        <button onClick={() => togglePanel("alarm")} aria-label="Alarmes"><AlarmClock size={15}/></button>
        <button onClick={() => togglePanel("reminder")} aria-label="Lembretes"><Bell size={15}/></button>
        <button onClick={() => togglePanel("weather")} aria-label="Tempo"><CloudSun size={15}/></button>
<button onClick={() => togglePanel("focus")} aria-label="Pomodoro"><Timer size={15}/></button>
      </div>
    </section>

    {ringing && <section className="ringing-banner" role="alert"><div><strong>⏰ {ringing.label}</strong><span>O alarme está tocando. Pare ou adie por 5 minutos.</span></div><div className="ringing-actions"><button className="primary-btn" onClick={dismissAlarm}>Parar</button><button className="secondary-btn" onClick={snoozeAlarm}>Adiar 5 min</button></div></section>}

    {panel && <section className="panel">
      <header className="panel-header"><div><span className="eyebrow">PERICLES / CONTROLE</span><h2>{panel === "alarm" ? "Alarmes" : panel === "reminder" ? "Lembretes" : panel === "weather" ? "Previsão do tempo" : panel === "focus" ? "Timer Pomodoro" : panel === "notes" ? "Notas" : "Configurações"}</h2></div><button className="icon-btn" onClick={() => setPanel(null)} aria-label="Fechar painel"><X size={18}/></button></header>
      {panel === "alarm" && <div className="panel-content">
        <form onSubmit={addAlarm} className="form-stack"><label>Horário<input type="time" value={alarmTime} onChange={e=>setAlarmTime(e.target.value)} required/></label><label>Nome do alarme<input value={alarmLabel} onChange={e=>setAlarmLabel(e.target.value)} placeholder="Ex.: Pausa para café" maxLength={60} required/></label><label className="check-row"><input type="checkbox" checked={alarmRepeat} onChange={e=>setAlarmRepeat(e.target.checked)}/> Repetir diariamente</label><div className="alarm-actions"><button className="primary-btn"><Plus size={16}/> Adicionar alarme</button><button type="button" className="secondary-btn" onClick={() => { getAudioContext(); setRinging({ label: "Teste de som" }); startAlarmSound(); }}><Volume2 size={15}/> Testar som</button><button type="button" className="secondary-btn" onClick={() => setVolumeModalOpen(true)}>Volume do alarme</button><button type="button" className="secondary-btn" onClick={() => setSoundModalOpen(true)}>Som do alarme</button></div></form>
        <div className="items">{alarms.length ? alarms.map(a=><div className="item" key={a.id}><div><strong>{a.time}</strong><span>{a.label}{a.repeat ? " · Diário" : ""}</span></div><button className="icon-btn" onClick={()=>setAlarms(old=>old.map(x=>x.id===a.id?{...x,enabled:!x.enabled}:x))} title={a.enabled?"Pausar":"Ativar"}>{a.enabled?<Pause size={16}/>:<Play size={16}/>}</button><button className="icon-btn danger" onClick={()=>setAlarms(old=>old.filter(x=>x.id!==a.id))} title="Excluir"><X size={16}/></button></div>) : <p className="empty">Nenhum alarme cadastrado.</p>}</div>
        {snooze && <div className="snooze"><span>Alarme: {snooze.label}</span><button className="primary-btn" onClick={()=>setSnooze({label:snooze.label,until:Date.now()+5*60*1000})}>Adiar mais 5 min</button></div>}
      </div>}
      {panel === "reminder" && <div className="panel-content"><form onSubmit={addReminder} className="form-stack"><label style={{gridColumn:"1 / -1"}}>O que você precisa lembrar?<input value={reminderTitle} onChange={e=>setReminderTitle(e.target.value)} placeholder="Ex.: Enviar orçamento" maxLength={120} required/></label><label>Data e hora (opcional)<input type="datetime-local" value={reminderDue} onChange={e=>setReminderDue(e.target.value)}/></label><label>Categoria (opcional)<input value={reminderTag} onChange={e=>setReminderTag(e.target.value)} placeholder="Ex.: Trabalho" maxLength={40}/></label><div className="check-row" style={{display:"flex",alignItems:"center",justifyContent:"flex-start",gap:"8px"}}><button type="button" className={reminderRepeat ? "primary-btn" : "secondary-btn"} onClick={() => setReminderRepeat(v => !v)}>{reminderRepeat ? <Check size={15}/> : <Plus size={15}/>} Repetir diariamente</button><button className="primary-btn"><Plus size={16}/> Salvar lembrete</button></div></form><div className="reminder-toolbar"><input className="reminder-search" value={reminderSearch} onChange={e=>setReminderSearch(e.target.value)} placeholder="Buscar lembretes..."/><div className="reminder-filters"><button type="button" className={reminderFilter==="all"?"active":""} onClick={()=>setReminderFilter("all")}>Todos</button><button type="button" className={reminderFilter==="pending"?"active":""} onClick={()=>setReminderFilter("pending")}>Pendentes</button><button type="button" className={reminderFilter==="done"?"active":""} onClick={()=>setReminderFilter("done")}>Concluídos</button></div></div><div className="items">{filteredReminders.length ? filteredReminders.map(r=> editingReminderId === r.id ? <div className={`item ${r.done?"done":""}`} key={r.id}><div className="item-text" style={{width:"100%"}}><form className="modal-form" onSubmit={e => { e.preventDefault(); setReminders(old => old.map(x => x.id === r.id ? { ...x, title: editingReminderValue.title.trim() || x.title, due: editingReminderValue.due } : x)); setEditingReminderId(null); }}><label>Descrição<input value={editingReminderValue.title} onChange={e => setEditingReminderValue(v => ({ ...v, title: e.target.value }))} required maxLength={120}/></label><label>Data e hora<input type="datetime-local" value={editingReminderValue.due} onChange={e => setEditingReminderValue(v => ({ ...v, due: e.target.value }))}/></label><div className="alarm-actions"><button className="primary-btn" type="submit"><Check size={15}/> Salvar</button><button className="secondary-btn" type="button" onClick={() => setEditingReminderId(null)}>Cancelar</button></div></form></div></div> : <div className={`item ${r.done?"done":""}`} key={r.id}><button className="check-btn" onClick={()=>setReminders(old=>old.map(x=>x.id===r.id?{...x,done:!x.done}:x))} aria-label={r.done?"Reabrir":"Concluir"}><Check size={15}/></button><div className="item-text"><strong>{r.title}</strong><span>{r.due ? new Date(r.due).toLocaleString("pt-BR") : "Sem horário definido"}{r.repeat ? " · Repetir diário" : ""}{r.tag ? ` · ${r.tag}` : ""}</span></div><button className="icon-btn" title="Editar" onClick={() => { setEditingReminderId(r.id); setEditingReminderValue({ title: r.title, due: r.due }); }}><Settings2 size={16}/></button><button className="icon-btn danger" onClick={()=>setReminders(old=>old.filter(x=>x.id!==r.id))} aria-label="Excluir"><X size={16}/></button></div>) : <p className="empty">Nenhum lembrete cadastrado.</p>}</div></div>}
      {panel === "weather" && <div className="panel-content">
        <form className="city-form" onSubmit={e => { e.preventDefault(); setShowSuggestions(false); void fetchWeather(); }}>
          <label>Cidade
            <div className="city-input">
              <input
                value={city}
                onChange={e => { setCity(e.target.value); setLocationError(""); }}
                onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                onBlur={() => setShowSuggestions(false)}
                onKeyDown={handleCityKeyDown}
                placeholder="Digite para buscar…"
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-expanded={showSuggestions}
                aria-autocomplete="list"
              />
              <span className="city-input-icon" aria-hidden="true">{searchingCity ? <span className="city-spinner"/> : <Search size={14}/>}</span>
            </div>
          </label>
          <button className="primary-btn">Atualizar</button>
        </form>
        {showSuggestions && suggestions.length > 0 && <ul className="city-suggestions" role="listbox">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === activeSuggestion}
                className={`city-suggestion${index === activeSuggestion ? " active" : ""}`}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setActiveSuggestion(index)}
                onClick={() => chooseSuggestion(suggestion)}
              >
                <span className="city-suggestion-name">{suggestion.name}</span>
                <span className="city-suggestion-meta">{[suggestion.admin1, suggestion.country].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>}
        <button type="button" className="secondary-btn location-btn" onClick={() => void useMyLocation()} disabled={locating}>
          <LocateFixed size={15}/> {locating ? "Detectando localização…" : "Usar minha localização"}
        </button>
        {locationError && <p className="error">{locationError}</p>}
        {weather ? <div className="weather-card"><CloudSun size={32}/><div><strong>{Math.round(weather.temperature)}°C · {weatherText(weather.code)}</strong><span>{weather.city}</span></div><div className="weather-details"><span>Sensação térmica <b>{Math.round(weather.apparent)}°C</b></span><span>Umidade <b>{weather.humidity}%</b></span></div></div> : <p className="empty">{weatherError || "Consultando previsão..."}</p>}{weather?.forecast && weather.forecast.length > 0 && <div className="forecast-list">{weather.forecast.slice(0, 5).map(day => <div className="forecast-day" key={day.date}><span>{new Date(day.date).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit" })}</span><span>{weatherText(day.code)}</span><b>{Math.round(day.max)}° / {Math.round(day.min)}°</b></div>)}</div>}{weatherError && <p className="error">{weatherError}</p>}<p className="hint">Digite a cidade e escolha uma opção da lista, ou use sua localização atual. Dados meteorológicos via Open-Meteo — é necessária conexão com a internet.</p>
      </div>}
      {panel === "focus" && <div className="panel-content">
  <div className="reminder-filters" style={{marginBottom:"8px", flexWrap:"wrap"}}>
    <button type="button" className={productivityTab==="pomodoro"?"active":""} onClick={() => setProductivityTab("pomodoro")}>Pomodoro</button>
    <button type="button" className={productivityTab==="stopwatch"?"active":""} onClick={() => setProductivityTab("stopwatch")}>Cronômetro</button>

  </div>
  {productivityTab === "pomodoro" && <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:"12px",padding:"8px 0"}}>
    <span className="eyebrow">{focusMode === "focus" ? "FOCO" : "PAUSA"}</span>
    <strong style={{fontSize:"44px",letterSpacing:"2px"}}>{formatFocusTime(focusRemaining)}</strong>
    <div className="form-stack" style={{width:"100%"}}>
      <label>Foco (min)<input type="number" min="1" max="120" value={focusWork} onChange={e => setFocusWork(Math.max(1, Number(e.target.value) || 1))} disabled={focusRunning}/></label>
      <label>Pausa (min)<input type="number" min="1" max="60" value={focusBreak} onChange={e => setFocusBreak(Math.max(1, Number(e.target.value) || 1))} disabled={focusRunning}/></label>
    </div>
    <div className="alarm-actions" style={{width:"100%"}}>
      <button className="primary-btn" onClick={() => setFocusRunning(v => !v)}>{focusRunning ? <Pause size={16}/> : <Play size={16}/>} {focusRunning ? "Pausar" : "Iniciar"}</button>
      <button className="secondary-btn" onClick={() => { setFocusRunning(false); setFocusMode("focus"); setFocusRemaining(focusWork * 60); }}>Reiniciar</button>
      <button className="secondary-btn" onClick={() => { setFocusRunning(false); if (focusMode === "focus") { setFocusMode("break"); setFocusRemaining(focusBreak * 60); } else { setFocusMode("focus"); setFocusRemaining(focusWork * 60); } }}>Pular</button>
    </div>
    <p className="hint">Sessões concluídas: {focusSessions}. O timer toca ao concluir cada etapa.</p>
  </div>}
  {productivityTab === "stopwatch" && <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:"12px",padding:"8px 0"}}>
    <strong style={{fontSize:"44px",letterSpacing:"2px"}}>{new Date(stopwatchElapsed).toISOString().substr(11, 11).replace(/^0/, "")}</strong>
    <div className="alarm-actions" style={{width:"100%"}}>
      <button className="primary-btn" onClick={() => setStopwatchRunning(v => !v)}>{stopwatchRunning ? <Pause size={16}/> : <Play size={16}/>} {stopwatchRunning ? "Pausar" : "Iniciar"}</button>
      <button className="secondary-btn" onClick={() => { setStopwatchRunning(false); setStopwatchElapsed(0); setStopwatchLaps([]); }}>Zerar</button>
      <button className="secondary-btn" onClick={() => setStopwatchLaps(old => [stopwatchElapsed, ...old])} disabled={!stopwatchRunning}>Volta</button>
    </div>
    {stopwatchLaps.length > 0 && <div className="items" style={{width:"100%"}}>{stopwatchLaps.map((lap, index) => <div className="item" key={index}><span>Volta {stopwatchLaps.length - index}</span><strong>{new Date(lap).toISOString().substr(11, 11).replace(/^0/, "")}</strong></div>)}</div>}
  </div>}
  {false && productivityTab === "notes" && <div style={{display:"flex",flexDirection:"column",gap:"8px",padding:"8px 0"}}>
    <form onSubmit={e => { e.preventDefault(); if (!noteDraft.trim()) return; setNotes(old => [{ id: crypto.randomUUID(), text: noteDraft.trim(), createdAt: Date.now() }, ...old]); setNoteDraft(""); }} className="form-stack">
      <label style={{gridColumn:"1 / -1"}}>Nova nota rápida<textarea value={noteDraft} onChange={e => setNoteDraft(e.target.value)} placeholder="Escreva uma nota..." rows={3}/></label>
      <button className="primary-btn"><Plus size={16}/> Salvar nota</button>
    </form>
    <div className="items">{notes.length ? notes.map(n => <div className="item" key={n.id}><div><span>{new Date(n.createdAt).toLocaleString("pt-BR")}</span><strong style={{fontWeight:400}}>{n.text}</strong></div><button className="icon-btn danger" onClick={() => setNotes(old => old.filter(x => x.id !== n.id))} title="Excluir"><X size={16}/></button></div>) : <p className="empty">Nenhuma nota ainda.</p>}</div>
  </div>}
  {false && productivityTab === "shortcuts" && <div style={{display:"flex",flexDirection:"column",gap:"8px",padding:"8px 0"}}>
    <form onSubmit={e => { e.preventDefault(); if (!shortcutLabel.trim() || !shortcutUrl.trim()) return; setShortcuts(old => [...old, { id: crypto.randomUUID(), label: shortcutLabel.trim(), url: shortcutUrl.trim() }]); setShortcutLabel(""); setShortcutUrl(""); }} className="form-stack">
      <label>Nome<input value={shortcutLabel} onChange={e => setShortcutLabel(e.target.value)} placeholder="Ex.: Gmail"/></label>
      <label>URL<input value={shortcutUrl} onChange={e => setShortcutUrl(e.target.value)} placeholder="https://..."/></label>
      <button className="primary-btn"><Plus size={16}/> Adicionar atalho</button>
    </form>
    <div className="items">{shortcuts.length ? shortcuts.map(s => <div className="item" key={s.id}><button className="secondary-btn" onClick={() => window.open(s.url, "_blank")}>{s.label}</button><button className="icon-btn danger" onClick={() => setShortcuts(old => old.filter(x => x.id !== s.id))} title="Excluir"><X size={16}/></button></div>) : <p className="empty">Nenhum atalho cadastrado.</p>}</div>
  </div>}
</div>}
{panel === "notes" && <div className="panel-content">
  <div style={{display:"flex",flexDirection:"column",gap:"8px",padding:"8px 0"}}>
    <form onSubmit={e => { e.preventDefault(); if (!noteDraft.trim()) return; setNotes(old => [{ id: crypto.randomUUID(), text: noteDraft.trim(), createdAt: Date.now() }, ...old]); setNoteDraft(""); }} className="form-stack">
      <label style={{gridColumn:"1 / -1"}}>Nova nota rápida<textarea value={noteDraft} onChange={e => setNoteDraft(e.target.value)} placeholder="Escreva uma nota..." rows={3}/></label>
      <button className="primary-btn"><Plus size={16}/> Salvar nota</button>
    </form>
    <div className="items">{notes.length ? notes.map(n => <div className="item" key={n.id}><div><span>{new Date(n.createdAt).toLocaleString("pt-BR")}</span><strong style={{fontWeight:400}}>{n.text}</strong></div><button className="icon-btn danger" onClick={() => setNotes(old => old.filter(x => x.id !== n.id))} title="Excluir"><X size={16}/></button></div>) : <p className="empty">Nenhuma nota ainda.</p>}</div>
  </div>
</div>}
{panel === "settings" && <div className="panel-content"><label className="setting-row"><span><strong>Sobre outros programas</strong><small>Manter o widget à frente das janelas</small></span><input type="checkbox" checked={prefs.alwaysOnTop} onChange={e=>updatePrefs({alwaysOnTop:e.target.checked})}/></label><label className="setting-row"><span><strong>Modo área de trabalho</strong><small>Manter o widget atrás das outras janelas</small></span><input type="checkbox" checked={prefs.showOnDesktopOnly} disabled={prefs.alwaysOnTop} onChange={e=>updatePrefs({showOnDesktopOnly:e.target.checked})}/></label><label className="setting-row"><span><strong>Iniciar com o Windows</strong><small>Abrir automaticamente ao entrar no Windows</small></span><input type="checkbox" checked={prefs.launchAtLogin} onChange={e=>updatePrefs({launchAtLogin:e.target.checked})}/></label><label className="setting-row"><span><strong>Mostrar nas duas telas</strong><small>Um widget em cada monitor — arraste cada um separadamente</small></span><input type="checkbox" checked={prefs.dualMonitor} onChange={e=>updatePrefs({dualMonitor:e.target.checked})}/></label>{dualScreenError && <p className="error">{dualScreenError}</p>}<label className="setting-row"><span><strong>Travar posição do widget</strong><small>Impede mover e fixa no topo centralizado</small></span><input type="checkbox" checked={prefs.lockPosition} onChange={e=>updatePrefs({lockPosition:e.target.checked})}/></label><label className="setting-row"><span><strong>Notificações</strong><small>Enviar alertas de alarmes e lembretes</small></span><input type="checkbox" checked={prefs.notificationsEnabled} onChange={e=>{ updatePrefs({notificationsEnabled:e.target.checked}); if (e.target.checked) void notify("Notificações ativadas", "O Pericles Desktop Widget agora pode enviar alertas."); }}/></label><label className="setting-row"><span><strong>Métricas do sistema</strong><small>Mostrar CPU, RAM, rede e bateria (opcional)</small></span><input type="checkbox" checked={prefs.systemMetricsEnabled} onChange={e=>updatePrefs({systemMetricsEnabled:e.target.checked})}/></label>
<div className="alarm-actions" style={{justifyContent:"center"}}><button className="secondary-btn" type="button" onClick={() => void notify("Teste de notificação", "Se você vê esta mensagem, as notificações estão funcionando.")}>Testar notificação</button><button className="secondary-btn" type="button" onClick={() => void invoke("open_external", { url: "ms-settings:notifications" })}>Configurações do Windows</button><button className="secondary-btn" type="button" onClick={() => setShortcutsModalOpen(true)}>Atalhos</button><button className="secondary-btn" type="button" onClick={() => setTransparencyModalOpen(true)}>Transparência do fundo</button><button className="secondary-btn" type="button" onClick={() => setMetricsModalOpen(true)}>Métricas</button></div><div className="alarm-actions" style={{justifyContent:"center"}}><button className="secondary-btn" type="button" onClick={() => void exportBackup()}>Exportar backup</button><button className="secondary-btn" type="button" onClick={() => void chooseBackup()}>Importar backup</button></div>{restoreData && <div className="alarm-actions" style={{justifyContent:"center"}}><button className="secondary-btn" type="button" onClick={() => void applyBackup()}>Confirmar substituição</button><button className="secondary-btn" type="button" onClick={() => setRestoreData(null)}>Cancelar</button></div>}{backupMessage && <p className="hint">{backupMessage}</p>}<p className="hint">Se o app não aparecer na lista do Windows, clique em “Testar notificação” (ou ative as notificações) para registrá-lo e depois reabra as configurações.</p><p className="hint">A exibição na tela de bloqueio depende das configurações do Windows: ative “Mostrar notificações na tela de bloqueio” e “Mostrar conteúdo da notificação”.</p><p className="hint">As preferências são salvas neste computador e aplicadas imediatamente.</p></div>}
    </section>}
  {commandOpen && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:"80px",zIndex:50}} onClick={() => setCommandOpen(false)}>
    <div style={{width:"min(420px,90vw)",background:"#1f2228",border:"1px solid #3a3e46",borderRadius:"12px",padding:"12px",boxShadow:"0 10px 40px rgba(0,0,0,.5)"}} onClick={e => e.stopPropagation()}>
      <input autoFocus value={commandQuery} onChange={e => setCommandQuery(e.target.value)} placeholder="Buscar comando..." style={{width:"100%",padding:"10px",borderRadius:"8px",border:"1px solid #3a3e46",background:"rgba(255,255,255,.04)",color:"#f4f5f7"}}/>
      <div className="items" style={{marginTop:"8px",maxHeight:"300px",overflow:"auto"}}>
        {[
          { label: "Abrir Alarmes", action: () => togglePanel("alarm") },
          { label: "Abrir Lembretes", action: () => togglePanel("reminder") },
          { label: "Abrir Previsão do tempo", action: () => togglePanel("weather") },
          { label: "Abrir Configurações", action: () => togglePanel("settings") },
          { label: "Abrir Produtividade", action: () => togglePanel("focus") },
          { label: "Alternar sempre no topo", action: () => updatePrefs({ alwaysOnTop: !prefs.alwaysOnTop }) },
          { label: "Alternar modo área de trabalho", action: () => updatePrefs({ showOnDesktopOnly: !prefs.showOnDesktopOnly }) },
        ].filter(c => c.label.toLowerCase().includes(commandQuery.toLowerCase())).map(c => <button key={c.label} className="secondary-btn" style={{width:"100%",textAlign:"left"}} onClick={() => { c.action(); setCommandOpen(false); setCommandQuery(""); }}>{c.label}</button>)}
      </div>
      <p className="hint" style={{marginTop:"8px"}}>Atalho: Ctrl+K / Cmd+K · Esc para fechar</p>
    </div>
  </div>}
  {shortcutsModalOpen && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50}} onClick={() => setShortcutsModalOpen(false)}>
    <div style={{width:"min(420px,90vw)",background:"#1f2228",border:"1px solid #3a3e46",borderRadius:"12px",padding:"16px",boxShadow:"0 10px 40px rgba(0,0,0,.5)"}} onClick={e => e.stopPropagation()}>
      <h3 style={{margin:"0 0 10px"}}>Atalhos</h3>
      <form onSubmit={e => { e.preventDefault(); if (!shortcutLabel.trim() || !shortcutUrl.trim()) return; setShortcuts(old => [...old, { id: crypto.randomUUID(), label: shortcutLabel.trim(), url: shortcutUrl.trim() }]); setShortcutLabel(""); setShortcutUrl(""); }} className="form-stack">
        <label>Nome<input value={shortcutLabel} onChange={e => setShortcutLabel(e.target.value)} placeholder="Ex.: Gmail"/></label>
        <label>URL<input value={shortcutUrl} onChange={e => setShortcutUrl(e.target.value)} placeholder="https://..."/></label>
        <button className="primary-btn" style={{gridColumn:"1 / -1"}}><Plus size={16}/> Adicionar atalho</button>
      </form>
      <div className="items" style={{marginTop:"10px"}}>{shortcuts.length ? shortcuts.map(s => <div className="item" key={s.id}><button className="secondary-btn" onClick={() => window.open(s.url, "_blank")}>{s.label}</button><button className="icon-btn danger" onClick={() => setShortcuts(old => old.filter(x => x.id !== s.id))} title="Excluir"><X size={16}/></button></div>) : <p className="empty">Nenhum atalho cadastrado.</p>}</div>
      <button className="secondary-btn" style={{marginTop:"10px",width:"100%"}} onClick={() => setShortcutsModalOpen(false)}>Fechar</button>
    </div>
  </div>}
  {transparencyModalOpen && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50}} onClick={() => setTransparencyModalOpen(false)}>
    <div style={{width:"min(360px,90vw)",background:"#1f2228",border:"1px solid #3a3e46",borderRadius:"12px",padding:"16px",boxShadow:"0 10px 40px rgba(0,0,0,.5)"}} onClick={e => e.stopPropagation()}>
      <h3 style={{margin:"0 0 10px"}}>Transparência do fundo</h3>
      <label className="range-label">Transparência <strong>{prefs.opacity}%</strong><input type="range" min="45" max="100" value={prefs.opacity} onChange={e=>updatePrefs({opacity:Number(e.target.value)})}/></label>
      <button className="secondary-btn" style={{marginTop:"10px",width:"100%"}} onClick={() => setTransparencyModalOpen(false)}>Fechar</button>
    </div>
  </div>}
  {volumeModalOpen && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50}} onClick={() => setVolumeModalOpen(false)}>
    <div style={{width:"min(360px,90vw)",background:"#1f2228",border:"1px solid #3a3e46",borderRadius:"12px",padding:"16px",boxShadow:"0 10px 40px rgba(0,0,0,.5)"}} onClick={e => e.stopPropagation()}>
      <h3 style={{margin:"0 0 10px"}}>Volume do alarme</h3>
      <label className="range-label">Volume <strong>{prefs.alarmVolume}%</strong><input type="range" min="0" max="100" value={prefs.alarmVolume} onChange={e=>updatePrefs({alarmVolume:Number(e.target.value)})}/></label>
      <button className="secondary-btn" style={{marginTop:"10px",width:"100%"}} onClick={() => setVolumeModalOpen(false)}>Fechar</button>
    </div>
  </div>}
{soundModalOpen && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50}} onClick={() => setSoundModalOpen(false)}>
    <div style={{width:"min(360px,90vw)",background:"#1f2228",border:"1px solid #3a3e46",borderRadius:"12px",padding:"16px",boxShadow:"0 10px 40px rgba(0,0,0,.5)"}} onClick={e => e.stopPropagation()}>
      <h3 style={{margin:"0 0 10px"}}>Som do alarme</h3>
      <label className="setting-row"><span><strong>Som</strong><small>Usado em alarmes e lembretes</small></span><select value={prefs.alarmSound} onChange={e=>updatePrefs({alarmSound:e.target.value})} style={{border:"1px solid #3a3e46",borderRadius:"9px",background:"rgba(255,255,255,.045)",color:"#f4f5f7",padding:"8px 10px"}}><option value="classic">Clássico</option><option value="beep">Bipe</option><option value="bell">Sino</option><option value="digital">Digital</option><option value="soft">Suave</option></select></label>
      <button className="secondary-btn" style={{marginTop:"10px",width:"100%"}} onClick={() => setSoundModalOpen(false)}>Fechar</button>
    </div>
  </div>}
    {metricsModalOpen && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50}} onClick={() => setMetricsModalOpen(false)}>
    <div style={{width:"min(420px,90vw)",background:"#1f2228",border:"1px solid #3a3e46",borderRadius:"12px",padding:"16px",boxShadow:"0 10px 40px rgba(0,0,0,.5)",maxHeight:"80vh",overflow:"auto"}} onClick={e => e.stopPropagation()}>
      <h3 style={{margin:"0 0 10px"}}>Selecionar métricas</h3>
      <p className="hint" style={{marginTop:0}}>Escolha quais métricas exibir no widget.</p>
      <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
        {[
          { key: "cpu", label: "CPU" },
          { key: "memory", label: "MEMÓRIA" },
          { key: "network", label: "REDE" },
          { key: "battery", label: "BATERIA" },
          { key: "gpu", label: "GPU" },
        ].map(opt => (
          <label key={opt.key} className="setting-row">
            <span><strong>{opt.label}</strong></span>
            <input type="checkbox" checked={(prefs.metricsSelected || []).includes(opt.key)} onChange={e => {
              const current = prefs.metricsSelected || [];
              const next = e.target.checked ? [...current, opt.key] : current.filter(k => k !== opt.key);
              updatePrefs({ metricsSelected: next });
            }}/>
          </label>
        ))}
        {(systemMetrics?.disks || []).map((disk, index) => (
          <label key={"disk-" + index} className="setting-row">
            <span><strong>DISCO {index}</strong><small>{disk.name || ""}</small></span>
            <input type="checkbox" checked={(prefs.metricsSelected || []).includes("disk:" + index)} onChange={e => {
              const key = "disk:" + index;
              const current = prefs.metricsSelected || [];
              const next = e.target.checked ? [...current, key] : current.filter(k => k !== key);
              updatePrefs({ metricsSelected: next });
            }}/>
          </label>
        ))}
      </div>
      <button className="secondary-btn" style={{marginTop:"12px",width:"100%"}} onClick={() => setMetricsModalOpen(false)}>Fechar</button>
    </div>
  </div>}
  </main>;
}