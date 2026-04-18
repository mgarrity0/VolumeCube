use std::io::Write;
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

struct WatcherState(Mutex<Option<RecommendedWatcher>>);

// Serial port handle. Held as a boxed dyn trait object because
// serialport::SerialPort is !Sized. Only one port open at a time.
struct SerialState(Mutex<Option<Box<dyn serialport::SerialPort>>>);

// UDP socket, bound once and reused for all WLED sends.
struct UdpState(Mutex<Option<UdpSocket>>);

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

// Recursively walks patterns/ and returns posix-style relative paths
// (e.g. "classics/plasma.js"). Flat filenames work the same way — no
// subdirectory is required, and the loader treats the name as opaque.
#[tauri::command]
fn list_patterns() -> Result<Vec<String>, String> {
    let root = project_root()?;
    let patterns_dir = PathBuf::from(&root).join("patterns");
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
fn read_pattern(name: String) -> Result<String, String> {
    // Guard against path traversal; nested subdirs are allowed via forward
    // slashes (the list_patterns output) but `..` is never valid.
    if name.contains("..") {
        return Err("invalid pattern name".into());
    }
    let root = project_root()?;
    let rel = name.replace('/', std::path::MAIN_SEPARATOR_STR);
    let path = PathBuf::from(&root).join("patterns").join(&rel);
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn project_root() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().ok_or("no exe parent")?.to_path_buf();

    let mut cursor = exe_dir.clone();
    for _ in 0..6 {
        if cursor.join("package.json").exists() {
            return Ok(cursor.to_string_lossy().to_string());
        }
        match cursor.parent() {
            Some(p) => cursor = p.to_path_buf(),
            None => break,
        }
    }
    Ok(exe_dir.to_string_lossy().to_string())
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
        sock.set_nonblocking(false).ok();
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
// exports/ directory. Rejects anything outside that directory so a
// malformed relative path can't escape the sandbox.
#[tauri::command]
fn write_export(rel_path: String, contents: String) -> Result<String, String> {
    if rel_path.contains("..") || rel_path.starts_with('/') || rel_path.starts_with('\\') {
        return Err("invalid export path".into());
    }
    let root = project_root()?;
    let exports = PathBuf::from(&root).join("exports");
    std::fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
    let path = exports.join(&rel_path);
    // Ensure the parent exists for nested names like "plasma/frames.ino".
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
            project_root,
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
        .setup(|_app| {
            if let Ok(root) = project_root() {
                let root = PathBuf::from(root);
                let _ = std::fs::create_dir_all(root.join("patterns"));
                let _ = std::fs::create_dir_all(root.join("exports"));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
