#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mixer;

use serde_json::Value;
use std::{
    fs,
    io::{self, Read, Write},
    path::PathBuf,
};

const MAX_LAYOUT: u64 = 256 * 1024;

fn layout_path() -> io::Result<PathBuf> {
    Ok(std::env::current_exe()?.with_file_name("layout-config.json"))
}

#[tauri::command]
fn load_layout() -> Result<Option<Value>, String> {
    let read = || -> io::Result<Option<Value>> {
        let file = match fs::File::open(layout_path()?) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut bytes = Vec::new();
        file.take(MAX_LAYOUT + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_LAYOUT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "layout-config.json is too large",
            ));
        }
        let config: Value = serde_json::from_slice(&bytes)?;
        if !config.is_object() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Layout config is not a JSON object",
            ));
        }
        Ok(Some(config))
    };
    read().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_layout(config: Value) -> Result<(), String> {
    let save = || -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(&config)?;
        if !config.is_object() || bytes.len() as u64 > MAX_LAYOUT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid layout config",
            ));
        }
        let path = layout_path()?;
        let mut file =
            tempfile::NamedTempFile::new_in(path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist(path)?;
        Ok(())
    };
    save().map_err(|e| e.to_string())
}

fn main() {
    use tauri::Manager;
    tauri::Builder::default()
        .setup(|app| {
            app.manage(mixer::start(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_layout,
            save_layout,
            mixer::mixer_snapshot,
            mixer::meter_channels,
            mixer::set_channel,
            mixer::set_pad,
            mixer::recorder,
            mixer::set_fx,
            mixer::restart_engine,
            mixer::recorder_load,
            mixer::recorder_goto,
            mixer::recorder_latest,
            mixer::recorder_out,
            mixer::set_bus_eq,
            mixer::read_bus_eq,
        ])
        .build(tauri::generate_context!())
        .expect("failed to create NoVeeter")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<mixer::Mixer>().stop();
            }
        });
}
