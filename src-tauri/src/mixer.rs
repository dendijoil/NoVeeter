use serde::{Deserialize, Serialize};
use std::{
    ffi::CString,
    sync::{
        atomic::{AtomicU16, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{async_runtime, AppHandle, Emitter, State};
use voicemeeter::{
    types::{Device, LevelType, ParameterNameRef, VoicemeeterApplication as Program},
    VoicemeeterRemote,
};

const ROUTES: [&str; 8] = ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3"];
const SENDS: [&str; 4] = ["Reverb", "Delay", "Fx1", "Fx2"];
const RETURNS: [&str; 4] = ["ReturnReverb", "ReturnDelay", "ReturnFx1", "ReturnFx2"];
const EQ_BANDS: [&str; 3] = ["EQGain1", "EQGain2", "EQGain3"];
const EQ_CELLS: usize = 6;
const DEVICES: [Device; 16] = [
    Device::Strip1,
    Device::Strip2,
    Device::Strip3,
    Device::Strip4,
    Device::Strip5,
    Device::VirtualInput,
    Device::VirtualInputAux,
    Device::VirtualInput8,
    Device::OutputA1,
    Device::OutputA2,
    Device::OutputA3,
    Device::OutputA4,
    Device::OutputA5,
    Device::VirtualOutputB1,
    Device::VirtualOutputB2,
    Device::VirtualOutputB3,
];

#[derive(Clone, Serialize)]
pub struct Snapshot {
    status: String,
    channels: Vec<Channel>,
    /// Fx.Reverb.On, Fx.Reverb.AB, Fx.Delay.On, Fx.Delay.AB.
    fx: [bool; 4],
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Channel {
    label: String,
    device: Option<String>,
    gain: f32,
    mute: bool,
    solo: bool,
    mono: u8,
    routes: [bool; 8],
    /// Physical strips: Color_x, Color_y, fx_x, fx_y, Pan_x, Pan_y.
    pad: Option<[f32; 6]>,
    /// Physical strips: Gate, Comp, Denoiser.
    audibility: Option<[f32; 3]>,
    /// Virtual strips: EQGain1..3.
    eq: Option<[f32; 3]>,
    /// Physical strips and buses: parametric EQ master switch.
    eq_on: Option<bool>,
    sends: [f32; 4],
    bus: Option<BusState>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BusState {
    eq_on: bool,
    eq_ab: bool,
    returns: [f32; 4],
}

#[derive(Clone, Serialize)]
pub struct EqCell {
    on: bool,
    kind: f32,
    freq: f32,
    gain: f32,
    q: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Control {
    Gain,
    Mute,
    Solo,
    Mono,
    Route,
    Gate,
    Comp,
    Denoiser,
    EqGain,
    Send,
    EqOn,
    EqAb,
    Return,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum EqField {
    On,
    Type,
    Freq,
    Gain,
    Q,
}

enum Message {
    Set(String, f32, async_runtime::Sender<Result<(), String>>),
    SetPad(String, async_runtime::Sender<Result<(), String>>),
    ReadEq(usize, async_runtime::Sender<Result<Vec<EqCell>, String>>),
    Stop,
}

pub struct Mixer {
    snapshot: Arc<Mutex<Snapshot>>,
    meters: Arc<AtomicU16>,
    tx: mpsc::SyncSender<Message>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Mixer {
    pub fn stop(&self) {
        let _ = self.tx.send(Message::Stop);
        if let Some(handle) = self.thread.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
}

#[tauri::command]
pub fn mixer_snapshot(mixer: State<'_, Mixer>) -> Snapshot {
    mixer.snapshot.lock().unwrap().clone()
}

#[tauri::command]
pub fn meter_channels(mixer: State<'_, Mixer>, mask: u16) {
    mixer.meters.store(mask, Ordering::Relaxed);
}

fn parameter(id: usize, field: &str) -> String {
    if id < 8 {
        format!("Strip[{id}].{field}")
    } else {
        format!("Bus[{}].{field}", id - 8)
    }
}

fn ranged(value: f32, low: f32, high: f32) -> bool {
    value.is_finite() && (low..=high).contains(&value)
}

fn toggle(value: f32) -> bool {
    value == 0.0 || value == 1.0
}

fn slot(
    index: Option<usize>,
    names: &'static [&'static str],
    what: &str,
) -> Result<&'static str, String> {
    index
        .and_then(|i| names.get(i))
        .copied()
        .ok_or_else(|| format!("invalid {what}"))
}

fn target(id: usize, control: Control, index: Option<usize>, value: f32) -> Result<String, String> {
    if id >= DEVICES.len() {
        return Err("Invalid channel".into());
    }
    let physical = id < 5;
    let virtual_strip = (5..8).contains(&id);
    let bus = id >= 8;
    let field = match control {
        Control::Gain if ranged(value, -60.0, 12.0) => "Gain",
        Control::Mute if toggle(value) => "Mute",
        Control::Solo if !bus && toggle(value) => "Solo",
        Control::Mono if toggle(value) || (bus && value == 2.0) => "Mono",
        Control::Route if !bus && toggle(value) => slot(index, &ROUTES, "Routing")?,
        Control::Gate if physical && ranged(value, 0.0, 10.0) => "Gate",
        Control::Comp if physical && ranged(value, 0.0, 10.0) => "Comp",
        Control::Denoiser if physical && ranged(value, 0.0, 10.0) => "Denoiser",
        Control::EqGain if virtual_strip && ranged(value, -12.0, 12.0) => {
            slot(index, &EQ_BANDS, "EQ band")?
        }
        Control::Send if !bus && ranged(value, 0.0, 10.0) => slot(index, &SENDS, "FX")?,
        Control::EqOn if (physical || bus) && toggle(value) => "EQ.on",
        Control::EqAb if bus && toggle(value) => "EQ.AB",
        Control::Return if bus && ranged(value, 0.0, 10.0) => slot(index, &RETURNS, "Return")?,
        _ => return Err("Invalid control or value".into()),
    };
    Ok(parameter(id, field))
}

fn eq_field(field: EqField, value: f32) -> Result<&'static str, String> {
    Ok(match field {
        EqField::On if toggle(value) => "on",
        EqField::Type if value.fract() == 0.0 && ranged(value, 0.0, 6.0) => "type",
        EqField::Freq if ranged(value, 20.0, 20_000.0) => "f",
        EqField::Gain if ranged(value, -36.0, 18.0) => "gain",
        EqField::Q if value.fract() == 0.0 && ranged(value, 1.0, 100.0) => "q",
        _ => return Err("Invalid EQ parameter".into()),
    })
}

// `id`: 0..4 physical strips, 8..15 buses (same ids as the UI). Virtual strips have no parametric EQ.
fn eq_valid(id: usize) -> bool {
    id < 5 || (8..16).contains(&id)
}

fn eq_parameter(id: usize, cell: usize, field: &str) -> String {
    // ponytail: edit the first audio lane; add a lane selector for per-channel EQ.
    format!("{}.EQ.channel[0].cell[{cell}].{field}", parameter(id, "").trim_end_matches('.'))
}

fn pad_script(id: usize, mode: &str, x: f32, y: f32) -> Result<String, String> {
    if id >= 5 || !ranged(x, -0.5, 0.5) || !ranged(y, 0.0, 1.0) {
        return Err("Invalid Intellipan channel or coordinates".into());
    }
    let mode = match mode {
        "color" => "Color",
        "fx" => "fx",
        "pan" => "Pan",
        _ => return Err("Invalid Intellipan mode".into()),
    };
    Ok(format!(
        "Strip[{id}].{mode}_x={x};Strip[{id}].{mode}_y={y};"
    ))
}

#[tauri::command]
pub async fn set_pad(
    mixer: State<'_, Mixer>,
    id: usize,
    mode: String,
    x: f32,
    y: f32,
) -> Result<(), String> {
    let script = pad_script(id, &mode, x, y)?;
    let (reply, mut response) = async_runtime::channel(1);
    request(&mixer, Message::SetPad(script, reply)).await?;
    response
        .recv()
        .await
        .ok_or_else(|| "Mixer unavailable".to_string())?
}

#[tauri::command]
pub async fn recorder_out(mixer: State<'_, Mixer>, bus: usize, on: bool) -> Result<(), String> {
    // Cassette playback output: any combination of A1..B3 (Recorder.A1 .. Recorder.B3).
    let route = ROUTES.get(bus).ok_or("Invalid recorder output")?;
    let script = format!("Recorder.{route}={};", u8::from(on));
    let (reply, mut response) = async_runtime::channel(1);
    request(&mixer, Message::SetPad(script, reply)).await?;
    response
        .recv()
        .await
        .ok_or_else(|| "Mixer unavailable".to_string())?
}

#[tauri::command]
pub async fn recorder(mixer: State<'_, Mixer>, action: String) -> Result<(), String> {
    // Only the transport; arms/bus mode stay whatever the user set in Voicemeeter.
    let script = match action.as_str() {
        "stop" | "play" | "record" => format!("Recorder.{action}=1;"),
        _ => return Err("Invalid recorder action".into()),
    };
    let (reply, mut response) = async_runtime::channel(1);
    request(&mixer, Message::SetPad(script, reply)).await?;
    response
        .recv()
        .await
        .ok_or_else(|| "Mixer unavailable".to_string())?
}

async fn request(mixer: &Mixer, message: Message) -> Result<(), String> {
    mixer
        .tx
        .try_send(message)
        .map_err(|_| "Mixer busy or unavailable".to_string())
}

#[tauri::command]
pub async fn set_channel(
    mixer: State<'_, Mixer>,
    id: usize,
    control: Control,
    index: Option<usize>,
    value: f32,
) -> Result<(), String> {
    let name = target(id, control, index, value)?;
    let (reply, mut response) = async_runtime::channel(1);
    request(&mixer, Message::Set(name, value, reply)).await?;
    response
        .recv()
        .await
        .ok_or_else(|| "Mixer unavailable".to_string())?
}

#[tauri::command]
pub async fn set_bus_eq(
    mixer: State<'_, Mixer>,
    id: usize,
    cell: usize,
    field: EqField,
    value: f32,
) -> Result<(), String> {
    if !eq_valid(id) || cell >= EQ_CELLS {
        return Err("Invalid EQ band".into());
    }
    let name = eq_parameter(id, cell, eq_field(field, value)?);
    let (reply, mut response) = async_runtime::channel(1);
    request(&mixer, Message::Set(name, value, reply)).await?;
    response
        .recv()
        .await
        .ok_or_else(|| "Mixer unavailable".to_string())?
}

#[tauri::command]
pub async fn read_bus_eq(mixer: State<'_, Mixer>, id: usize) -> Result<Vec<EqCell>, String> {
    if !eq_valid(id) {
        return Err("Invalid channel".into());
    }
    let (reply, mut response) = async_runtime::channel(1);
    request(&mixer, Message::ReadEq(id, reply)).await?;
    response
        .recv()
        .await
        .ok_or_else(|| "Mixer unavailable".to_string())?
}

fn read_eq(vm: &VoicemeeterRemote, id: usize) -> Result<Vec<EqCell>, String> {
    let number = |cell: usize, field: &str| {
        vm.get_parameter_float(ParameterNameRef::from_str(&eq_parameter(id, cell, field)))
            .map_err(|e| e.to_string())
    };
    (0..EQ_CELLS)
        .map(|cell| {
            Ok(EqCell {
                on: number(cell, "on")? != 0.0,
                kind: number(cell, "type")?,
                freq: number(cell, "f")?,
                gain: number(cell, "gain")?,
                q: number(cell, "q")?,
            })
        })
        .collect()
}

fn read_fx(vm: &VoicemeeterRemote) -> Result<[bool; 4], String> {
    let mut out = [false; 4];
    for (slot, name) in out
        .iter_mut()
        .zip(["Reverb.On", "Reverb.AB", "Delay.On", "Delay.AB"])
    {
        let value = vm
            .get_parameter_float(ParameterNameRef::from_str(&format!("Fx.{name}")))
            .map_err(|e| e.to_string())?;
        *slot = value != 0.0;
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct LoadedFile {
    path: String,
    /// Length in seconds from the Windows shell; None if unreadable.
    duration: Option<u32>,
}

/// "h:mm:ss" / "mm:ss" -> seconds. Keeps digits and ':' only (the shell may add invisible direction marks).
fn parse_clock(text: &str) -> Option<u32> {
    let clock: String = text.chars().filter(|c| c.is_ascii_digit() || *c == ':').collect();
    clock
        .split(':')
        .map(|p| p.parse::<u32>().ok())
        .try_fold(0u32, |acc, p| p.map(|p| acc * 60 + p))
        .filter(|d| *d > 0)
}

/// Native Windows open-file dialog (no extra crate); returns None when cancelled.
fn pick_audio_file() -> Result<Option<LoadedFile>, String> {
    use std::os::windows::process::CommandExt;
    let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Windows.Forms;        $d=New-Object System.Windows.Forms.OpenFileDialog;$d.Title='Open music for Recorder';        $d.Filter='Audio|*.wav;*.mp3;*.aiff;*.aif;*.bwf|All files|*.*';        if($d.ShowDialog() -eq 'OK'){$f=$d.FileName;$n=(New-Object -ComObject Shell.Application).NameSpace((Split-Path $f));        $len=$n.GetDetailsOf($n.ParseName((Split-Path $f -Leaf)),27);[Console]::Out.Write($f+[char]10+$len)}";
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-STA", "-NonInteractive", "-Command", script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut lines = text.lines();
    let path = lines.next().unwrap_or("").trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    let duration = parse_clock(lines.next().unwrap_or(""));
    Ok(Some(LoadedFile { path, duration }))
}

/// Newest audio file (written in the last 2 minutes) in the user's `Documents\Voicemeeter`,
/// where Potato saves recordings. Windows resolves Documents, so OneDrive redirection works.
fn latest_recording() -> Result<Option<LoadedFile>, String> {
    use std::os::windows::process::CommandExt;
    let script = r#"[Console]::OutputEncoding=[Text.Encoding]::UTF8;
$d=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Voicemeeter';
$f=Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '^\.(wav|mp3|aiff?|bwf)$' -and $_.LastWriteTime -gt (Get-Date).AddMinutes(-2) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1;
if($f){$n=(New-Object -ComObject Shell.Application).NameSpace($d);$len=$n.GetDetailsOf($n.ParseName($f.Name),27);[Console]::Out.Write($f.FullName+[char]10+$len)}"#;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-STA", "-NonInteractive", "-Command", script])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut lines = text.lines();
    let path = lines.next().unwrap_or("").trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    Ok(Some(LoadedFile { path, duration: parse_clock(lines.next().unwrap_or("")) }))
}

#[tauri::command]
pub async fn recorder_latest() -> Result<Option<LoadedFile>, String> {
    async_runtime::spawn_blocking(latest_recording)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn recorder_load(mixer: State<'_, Mixer>) -> Result<Option<LoadedFile>, String> {
    let Some(file) = async_runtime::spawn_blocking(pick_audio_file)
        .await
        .map_err(|e| e.to_string())??
    else {
        return Ok(None);
    };
    let path = &file.path;
    if path.contains(['"', ';']) {
        return Err("File path may not contain \" or ;".into());
    }
    let (reply, mut response) = async_runtime::channel(1);
    request(&mixer, Message::SetPad(format!("Recorder.mode.PlayOnLoad=0;Recorder.load=\"{path}\";"), reply)).await?;
    response
        .recv()
        .await
        .ok_or_else(|| "Mixer unavailable".to_string())??;
    Ok(Some(file))
}

#[tauri::command]
pub async fn recorder_goto(mixer: State<'_, Mixer>, sec: u32) -> Result<(), String> {
    let script = format!("Recorder.goto=\"{:02}:{:02}:{:02}\";", sec / 3600, sec % 3600 / 60, sec % 60);
    let (reply, mut response) = async_runtime::channel(1);
    request(&mixer, Message::SetPad(script, reply)).await?;
    response
        .recv()
        .await
        .ok_or_else(|| "Mixer unavailable".to_string())?
}

#[tauri::command]
pub async fn restart_engine(mixer: State<'_, Mixer>) -> Result<(), String> {
    let (reply, mut response) = async_runtime::channel(1);
    request(&mixer, Message::SetPad("Command.Restart=1;".into(), reply)).await?;
    response
        .recv()
        .await
        .ok_or_else(|| "Mixer unavailable".to_string())?
}

#[tauri::command]
pub async fn set_fx(
    mixer: State<'_, Mixer>,
    name: String,
    field: String,
    on: bool,
) -> Result<(), String> {
    if !matches!(name.as_str(), "Reverb" | "Delay") || !matches!(field.as_str(), "On" | "AB") {
        return Err("Invalid FX parameter".into());
    }
    let script = format!("Fx.{name}.{field}={};", u8::from(on));
    let (reply, mut response) = async_runtime::channel(1);
    request(&mixer, Message::SetPad(script, reply)).await?;
    response
        .recv()
        .await
        .ok_or_else(|| "Mixer unavailable".to_string())?
}

fn read_channel(vm: &VoicemeeterRemote, id: usize) -> Result<Channel, String> {
    let number = |field: &str| {
        let name = parameter(id, field);
        vm.get_parameter_float(ParameterNameRef::from_str(&name))
            .map_err(|e| e.to_string())
    };
    let text = |field: &str| {
        let raw = voicemeeter::get_voicemeeter_raw().ok()?;
        let name = CString::new(parameter(id, field)).ok()?;
        let mut buffer = [0u16; 512];
        // The Remote API writes at most 512 wchar values; this worker owns the call.
        if unsafe { raw.VBVMR_GetParameterStringW(name.as_ptr().cast_mut(), buffer.as_mut_ptr()) }
            != 0
        {
            return None;
        }
        Some(String::from_utf16_lossy(
            &buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len())],
        ))
    };
    let physical = id < 5;
    let virtual_strip = (5..8).contains(&id);
    let bus = id >= 8;
    let mut routes = [false; 8];
    if !bus {
        for (i, route) in ROUTES.iter().enumerate() {
            routes[i] = number(route)? != 0.0;
        }
    }
    let gain = number("Gain")?;
    if !gain.is_finite() {
        return Err("Invalid gain value from Potato".into());
    }
    Ok(Channel {
        label: text("Label").unwrap_or_default(),
        device: if id < 5 || (8..13).contains(&id) {
            text("device.name")
        } else {
            None
        },
        gain,
        mute: number("Mute")? != 0.0,
        solo: !bus && number("Solo")? != 0.0,
        mono: number("Mono")? as u8,
        routes,
        pad: if physical {
            Some([
                number("Color_x")?,
                number("Color_y")?,
                number("fx_x")?,
                number("fx_y")?,
                number("Pan_x")?,
                number("Pan_y")?,
            ])
        } else {
            None
        },
        audibility: if physical {
            Some([number("Gate")?, number("Comp")?, number("Denoiser")?])
        } else {
            None
        },
        eq: if virtual_strip {
            Some([number("EQGain1")?, number("EQGain2")?, number("EQGain3")?])
        } else {
            None
        },
        eq_on: if physical || bus {
            Some(number("EQ.on")? != 0.0)
        } else {
            None
        },
        sends: if bus {
            [0.0; 4]
        } else {
            [
                number("Reverb")?,
                number("Delay")?,
                number("Fx1")?,
                number("Fx2")?,
            ]
        },
        bus: if bus {
            Some(BusState {
                eq_on: number("EQ.on")? != 0.0,
                eq_ab: number("EQ.AB")? != 0.0,
                returns: [
                    number("ReturnReverb")?,
                    number("ReturnDelay")?,
                    number("ReturnFx1")?,
                    number("ReturnFx2")?,
                ],
            })
        } else {
            None
        },
    })
}

fn show_status(snapshot: &Mutex<Snapshot>, status: String) {
    *snapshot.lock().unwrap() = Snapshot {
        status,
        channels: vec![],
        fx: [false; 4],
    };
}

pub fn start(app: AppHandle) -> Mixer {
    let (tx, rx) = mpsc::sync_channel(32);
    let snapshot = Arc::new(Mutex::new(Snapshot {
        status: "Connecting to Potato…".into(),
        channels: vec![],
        fx: [false; 4],
    }));
    let meters = Arc::new(AtomicU16::new(0));
    let state = Arc::clone(&snapshot);
    let active = Arc::clone(&meters);
    let thread = thread::spawn(move || {
        // The Remote DLL requires level and dirty calls to stay on one thread.
        let mut remote = VoicemeeterRemote::new().map_err(|e| format!("Remote API: {e:?}"));
        let mut launch_attempted = false;
        let mut last_read = None;
        let mut last_probe = None;
        let mut ready = false;
        let mut dirty = true;
        let mut next = Instant::now();
        loop {
            match rx.recv_timeout(next.saturating_duration_since(Instant::now())) {
                Ok(Message::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Ok(Message::Set(name, value, reply)) => {
                    let result = match &remote {
                        Ok(vm) if ready => vm
                            .set_parameter_float(ParameterNameRef::from_str(&name), value)
                            .map_err(|e| e.to_string()),
                        _ => Err("Potato not connected".into()),
                    };
                    let _ = reply.try_send(result);
                }
                Ok(Message::SetPad(script, reply)) => {
                    let result = match &remote {
                        Ok(vm) if ready => vm.set_parameters(&script).map_err(|e| e.to_string()),
                        _ => Err("Potato not connected".into()),
                    };
                    let _ = reply.try_send(result);
                }
                Ok(Message::ReadEq(bus, reply)) => {
                    let result = match &remote {
                        Ok(vm) if ready => read_eq(vm, bus),
                        _ => Err("Potato not connected".into()),
                    };
                    let _ = reply.try_send(result);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            let now = Instant::now();
            if now < next {
                continue;
            }
            next = now + Duration::from_millis(33);
            if !ready
                && last_probe
                    .is_none_or(|at: Instant| now.duration_since(at) >= Duration::from_secs(1))
            {
                last_probe = Some(now);
                match &mut remote {
                    Ok(vm) => match vm.update_program() {
                        Ok(())
                            if matches!(
                                vm.program,
                                Program::VoicemeeterPotato | Program::PotatoX64Bits
                            ) =>
                        {
                            ready = true;
                            last_read = None;
                        }
                        Ok(()) if vm.program == Program::None && !launch_attempted => {
                            launch_attempted = true;
                            let status = match vm.run_voicemeeter(Program::PotatoX64Bits) {
                                Ok(()) => "Waiting for Voicemeeter Potato…".into(),
                                Err(e) => format!("Failed to launch Potato: {e}"),
                            };
                            show_status(&state, status);
                        }
                        Ok(()) if vm.program != Program::None => {
                            show_status(&state, "Open Voicemeeter Potato, not another edition.".into())
                        }
                        Ok(()) => {}
                        Err(e) => show_status(&state, format!("Remote API: {e}")),
                    },
                    Err(e) => show_status(
                        &state,
                        format!("{e}. Make sure Potato is installed, then reopen NoVeeter."),
                    ),
                }
            }
            let Ok(vm) = &remote else { continue };
            if !ready {
                continue;
            }
            match vm.is_parameters_dirty() {
                Ok(changed) => dirty |= changed,
                Err(e) => {
                    ready = false;
                    show_status(&state, format!("Potato connection lost: {e}"));
                    continue;
                }
            }
            if last_read.is_none_or(|at| {
                now.duration_since(at)
                    >= if dirty {
                        Duration::from_millis(99)
                    } else {
                        Duration::from_secs(1)
                    }
            }) {
                last_read = Some(now);
                dirty = false;
                match (0..16)
                    .map(|id| read_channel(vm, id))
                    .collect::<Result<Vec<_>, _>>()
                    .and_then(|channels| Ok((channels, read_fx(vm)?)))
                {
                    Ok((channels, fx)) => {
                        *state.lock().unwrap() = Snapshot {
                            status: "Connected".into(),
                            channels,
                            fx,
                        }
                    }
                    Err(e) => {
                        ready = false;
                        show_status(&state, format!("Potato parameters: {e}"));
                        continue;
                    }
                }
            }
            let mask = active.load(Ordering::Relaxed);
            let levels: Vec<_> = DEVICES
                .iter()
                .enumerate()
                .filter(|(id, _)| mask & (1 << id) != 0)
                .map(|(id, &device)| {
                    let kind = if id < 8 {
                        LevelType::PostMuteInputLevels
                    } else {
                        LevelType::OutputLevels
                    };
                    let stereo = [0, 1].map(|ch| {
                        vm.get_level(kind, device, ch)
                            .ok()
                            .flatten()
                            .filter(|v| v.is_finite())
                    });
                    (id, stereo)
                })
                .collect();
            if !levels.is_empty() {
                let _ = app.emit("mixer-levels", levels);
            }
        }
    });
    Mixer {
        snapshot,
        meters,
        tx,
        thread: Mutex::new(Some(thread)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_only_accepts_valid_channel_controls() {
        assert_eq!(
            target(7, Control::Route, Some(7), 1.0).unwrap(),
            "Strip[7].B3"
        );
        assert_eq!(target(15, Control::Mono, None, 2.0).unwrap(), "Bus[7].Mono");
        assert_eq!(
            pad_script(0, "color", 0.0, 0.0).unwrap(),
            "Strip[0].Color_x=0;Strip[0].Color_y=0;"
        );
        assert_eq!(
            pad_script(1, "pan", 0.25, 0.5).unwrap(),
            "Strip[1].Pan_x=0.25;Strip[1].Pan_y=0.5;"
        );
        assert!(pad_script(1, "x", 0.0, 0.0).is_err());
        assert_eq!(
            pad_script(4, "fx", -0.25, 0.5).unwrap(),
            "Strip[4].fx_x=-0.25;Strip[4].fx_y=0.5;"
        );
        assert!(pad_script(5, "color", 0.0, 0.0).is_err());
        assert!(pad_script(0, "color", f32::NAN, 0.0).is_err());
        assert_eq!(
            target(5, Control::EqGain, Some(2), -3.0).unwrap(),
            "Strip[5].EQGain3"
        );
        assert_eq!(
            target(8, Control::Return, Some(1), 5.0).unwrap(),
            "Bus[0].ReturnDelay"
        );
        assert_eq!(
            target(2, Control::Send, Some(3), 4.0).unwrap(),
            "Strip[2].Fx2"
        );
        assert!(target(16, Control::Mute, None, 1.0).is_err());
        assert!(target(8, Control::Solo, None, 1.0).is_err());
        assert!(target(0, Control::Route, Some(8), 1.0).is_err());
        assert!(target(0, Control::Gain, None, f32::NAN).is_err());
        assert!(target(0, Control::EqGain, Some(0), 0.0).is_err());
        assert!(target(5, Control::Gate, None, 1.0).is_err());
        assert!(target(8, Control::Send, Some(0), 1.0).is_err());
        assert!(target(5, Control::EqOn, None, 1.0).is_err());
        assert!(pad_script(0, "fx", 0.0, 1.5).is_err());
    }

    #[test]
    fn eq_cells_reject_out_of_range_values() {
        assert_eq!(
            eq_parameter(11, 5, eq_field(EqField::Freq, 1000.0).unwrap()),
            "Bus[3].EQ.channel[0].cell[5].f"
        );
        assert_eq!(eq_parameter(2, 0, "on"), "Strip[2].EQ.channel[0].cell[0].on");
        assert!(eq_valid(4) && eq_valid(8) && !eq_valid(5) && !eq_valid(16));
        assert_eq!(eq_field(EqField::Type, 6.0).unwrap(), "type");
        assert_eq!(eq_field(EqField::Q, 100.0).unwrap(), "q");
        assert!(eq_field(EqField::Gain, 19.0).is_err());
        assert!(eq_field(EqField::Freq, 20_001.0).is_err());
        assert!(eq_field(EqField::Type, 2.5).is_err());
        assert!(eq_field(EqField::On, 2.0).is_err());
    }

    #[test]
    fn clock_parses_shell_durations() {
        assert_eq!(parse_clock("00:00:08"), Some(8));
        assert_eq!(parse_clock("\u{200e}00:03:45\u{200f}"), Some(225));
        assert_eq!(parse_clock("1:02:03"), Some(3723));
        assert_eq!(parse_clock(""), None);
        assert_eq!(parse_clock("00:00:00"), None);
    }
}
