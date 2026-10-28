//! A deliberately small Tauri plugin backed by macOS Keychain. No filesystem fallback.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
const SERVICE: &str = "com.linjiejim.greenhouse";
fn valid_key(key: &str) -> bool {
    key.len() <= 180
        && [
            "greenhouse_access_token__",
            "greenhouse_refresh_token__",
            "greenhouse_member__",
            "greenhouse_user__",
            "greenhouse_me__",
        ]
        .iter()
        .any(|p| key.starts_with(p))
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn entry(key: &str) -> Result<keyring::Entry, String> {
    if !valid_key(key) {
        return Err("Invalid credential key".into());
    }
    keyring::Entry::new(SERVICE, key).map_err(|_| "Keychain unavailable".into())
}
#[tauri::command]
fn read(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Keychain access refused".into()),
    }
}
#[tauri::command]
fn write(key: String, value: Option<String>) -> Result<(), String> {
    let entry = entry(&key)?;
    let result = match value {
        Some(value) if value.len() <= 65536 => entry.set_password(&value),
        Some(_) => return Err("Credential too large".into()),
        None => entry.delete_credential(),
    };
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Keychain access refused".into()),
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("credentials")
        .invoke_handler(tauri::generate_handler![read, write])
        .build()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys_are_station_scoped() {
        assert!(valid_key("greenhouse_access_token__st-123"));
        for key in [
            "password",
            "greenhouse_pref_stations",
            "greenhouse_access_token__../other",
        ] {
            assert!(!valid_key(key));
        }
    }
}
