use std::io::Write;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};

struct WatcherState(Mutex<Option<RecommendedWatcher>>);

// Serial port handle. Held as a boxed dyn trait object because
// serialport::SerialPort is !Sized. Only one port open at a time.
struct SerialState(Mutex<Option<Box<dyn serialport::SerialPort>>>);

// UDP socket, bound once and reused for all WLED sends.
struct UdpState(Mutex<Option<UdpSocket>>);

// ---------- Pattern directory resolution ----------
//
// The app supports two modes:
//   • Dev (`tauri dev`): patterns live under <project_root>/patterns and are
//     edited in-repo. We walk up from the exe looking for package.json so
//     `cargo run` and `tauri dev` both find the workspace.
//   • Prod (shipped binary): there's no package.json on disk. Patterns live
//     under <app_data_dir>/patterns, which on first launch is seeded from
//     the bundled resource directory so users start with the full builtin
//     library. The writable app_data dir also means user patterns survive
//     app updates.
//
// The `patterns_root` command hands the JS side the right path for whichever
// mode it's running in.

fn dev_project_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut cursor = exe.parent()?.to_path_buf();
    for _ in 0..6 {
        if cursor.join("package.json").exists() {
            return Some(cursor);
        }
        cursor = cursor.parent()?.to_path_buf();
    }
    None
}

fn prod_patterns_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("patterns"))
        .map_err(|e| e.to_string())
}

fn resolved_patterns_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = dev_project_root() {
        return Ok(root.join("patterns"));
    }
    prod_patterns_dir(app)
}

fn resolved_exports_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = dev_project_root() {
        return Ok(root.join("exports"));
    }
    app.path()
        .app_data_dir()
        .map(|p| p.join("exports"))
        .map_err(|e| e.to_string())
}

/// Seed the user-writable patterns dir with the bundled resources on first
/// launch. Idempotent — skips any file that already exists so user edits
/// aren't clobbered. No-op in dev mode.
fn seed_patterns_if_empty(app: &AppHandle) -> Result<(), String> {
    if dev_project_root().is_some() {
        return Ok(());
    }
    let dest = prod_patterns_dir(app)?;
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    // Bundled-resource root. Tauri 2's `resolve_resource` returns a path
    // even if the target doesn't exist yet.
    let src = match app.path().resolve("patterns", tauri::path::BaseDirectory::Resource) {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    if !src.exists() {
        return Ok(());
    }
    copy_tree_skip_existing(&src, &dest).map_err(|e| e.to_string())
}

fn copy_tree_skip_existing(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if kind.is_dir() {
            copy_tree_skip_existing(&from, &to)?;
        } else if !to.exists() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn watch_patterns_dir(
    path: String,
    app: AppHandle,
    watcher_state: State<'_, WatcherState>,
) -> Result<(), String> {
    let mut guard = watcher_state.0.lock().map_err(|e| e.to_string())?;
    *guard = None; // drop any previous watcher

    let emitter = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            let paths: Vec<String> = event
                .paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let _ = emitter.emit(
                "patterns-changed",
                serde_json::json!({
                    "kind": format!("{:?}", event.kind),
                    "paths": paths,
                }),
            );
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(PathBuf::from(&path).as_path(), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *guard = Some(watcher);
    Ok(())
}

// Recursively walks the resolved patterns dir and returns posix-style
// relative paths (e.g. "classics/plasma.js").
#[tauri::command]
fn list_patterns(app: AppHandle) -> Result<Vec<String>, String> {
    let patterns_dir = resolved_patterns_dir(&app)?;
    let mut out = Vec::new();
    walk_patterns(&patterns_dir, &patterns_dir, &mut out);
    out.sort();
    Ok(out)
}

fn walk_patterns(base: &PathBuf, dir: &PathBuf, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk_patterns(base, &path, out);
            } else {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".js") || name.ends_with(".mjs") {
                    if let Ok(rel) = path.strip_prefix(base) {
                        out.push(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
        }
    }
}

#[tauri::command]
fn read_pattern(name: String, app: AppHandle) -> Result<String, String> {
    // Guard against path traversal; nested subdirs are allowed via forward
    // slashes (the list_patterns output) but `..` is never valid.
    if name.contains("..") {
        return Err("invalid pattern name".into());
    }
    let patterns_dir = resolved_patterns_dir(&app)?;
    let rel = name.replace('/', std::path::MAIN_SEPARATOR_STR);
    let path = patterns_dir.join(&rel);
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Path the JS side watches / displays in the Library panel. In dev this is
/// `<repo>/patterns`; in prod it's `<app_data_dir>/patterns`.
#[tauri::command]
fn patterns_root(app: AppHandle) -> Result<String, String> {
    resolved_patterns_dir(&app).map(|p| p.to_string_lossy().to_string())
}

// ---------- Transports ----------

// WLED / DDP / DRGB — all raw UDP sends. The JS side frames the packet
// (DDP header or DRGB prefix) and hands us a ready-to-send datagram.
#[tauri::command]
fn wled_send(
    ip: String,
    port: u16,
    bytes: Vec<u8>,
    udp_state: State<'_, UdpState>,
) -> Result<(), String> {
    let mut guard = udp_state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
        *guard = Some(sock);
    }
    let sock = guard.as_ref().unwrap();
    let addr = format!("{}:{}", ip, port);
    sock.send_to(&bytes, addr).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn serial_list() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports.into_iter().map(|p| p.port_name).collect())
}

#[tauri::command]
fn serial_open(
    port: String,
    baud: u32,
    serial_state: State<'_, SerialState>,
) -> Result<(), String> {
    let mut guard = serial_state.0.lock().map_err(|e| e.to_string())?;
    // Close any existing port first so the OS releases the handle before
    // we grab it again (common when reconnecting to the same device).
    *guard = None;

    let p = serialport::new(&port, baud)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| e.to_string())?;
    *guard = Some(p);
    Ok(())
}

#[tauri::command]
fn serial_send(
    bytes: Vec<u8>,
    serial_state: State<'_, SerialState>,
) -> Result<(), String> {
    let mut guard = serial_state.0.lock().map_err(|e| e.to_string())?;
    let port = guard.as_mut().ok_or("serial port not open")?;
    port.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn serial_close(serial_state: State<'_, SerialState>) -> Result<(), String> {
    let mut guard = serial_state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

// Writes a generated artifact (currently FastLED .ino sketches) into the
// exports/ directory (dev: <repo>/exports, prod: <app_data_dir>/exports).
// Rejects anything outside that directory so a malformed relative path
// can't escape the sandbox.
#[tauri::command]
fn write_export(rel_path: String, contents: String, app: AppHandle) -> Result<String, String> {
    if rel_path.contains("..") || rel_path.starts_with('/') || rel_path.starts_with('\\') {
        return Err("invalid export path".into());
    }
    let exports = resolved_exports_dir(&app)?;
    std::fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
    let path = exports.join(&rel_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState(Mutex::new(None)))
        .manage(SerialState(Mutex::new(None)))
        .manage(UdpState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            patterns_root,
            list_patterns,
            read_pattern,
            watch_patterns_dir,
            wled_send,
            serial_list,
            serial_open,
            serial_send,
            serial_close,
            write_export,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Seed builtin patterns into the user-writable dir on first run
            // (prod only). Failing here is non-fatal — the app just shows an
            // empty library.
            let _ = seed_patterns_if_empty(&handle);
            // Make sure both dirs exist so the watcher + exporter don't
            // race on first launch.
            if let Ok(p) = resolved_patterns_dir(&handle) {
                let _ = std::fs::create_dir_all(&p);
            }
            if let Ok(p) = resolved_exports_dir(&handle) {
                let _ = std::fs::create_dir_all(&p);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
