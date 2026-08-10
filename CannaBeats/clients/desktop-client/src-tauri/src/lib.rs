use reqwest::{Client, Method, Response, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::env;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

const DEFAULT_ORIGIN: &str = "https://poc.cannabeats.social";
const KEYRING_SERVICE: &str = "social.cannabeats.client";
const KEYRING_ACCOUNT: &str = "desktop-authorization";

struct PendingAuthorization {
    token: String,
    verification_url: String,
}

struct ClientState {
    origin: String,
    http: Client,
    token: Mutex<Option<String>>,
    pending: Mutex<Option<PendingAuthorization>>,
}

#[derive(Debug)]
struct ApiFailure {
    status: Option<StatusCode>,
    message: String,
}

impl std::fmt::Display for ApiFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct User {
    id: String,
    display_name: String,
    role: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Application {
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    user: User,
    application: Application,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponse {
    origin: String,
    authorized: bool,
    user: Option<User>,
    application: Option<Application>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizationStartResponse {
    code: String,
    authorization_token: String,
    verification_url: String,
    expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizationStartView {
    code: String,
    verification_url: String,
    expires_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizationStatusResponse {
    status: String,
    user: Option<User>,
    application: Option<Application>,
    expires_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameLaunchResponse {
    launch_url: String,
}

fn configured_origin() -> Result<String, String> {
    let candidate = env::var("CANNABEATS_ORIGIN").unwrap_or_else(|_| DEFAULT_ORIGIN.to_owned());
    let parsed =
        Url::parse(&candidate).map_err(|_| "CANNABEATS_ORIGIN is not a valid URL".to_owned())?;
    let local_development = parsed.scheme() == "http"
        && matches!(parsed.host_str(), Some("localhost") | Some("127.0.0.1"));
    if parsed.scheme() != "https" && !local_development {
        return Err("CANNABEATS_ORIGIN must use HTTPS except for local development".to_owned());
    }
    Ok(parsed.origin().ascii_serialization())
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("Could not access the operating-system credential store: {error}"))
}

fn load_saved_token() -> Result<Option<String>, String> {
    match credential_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Could not read the saved CannaBeats authorization: {error}"
        )),
    }
}

fn save_token(token: &str) -> Result<(), String> {
    credential_entry()?.set_password(token).map_err(|error| {
        format!("Could not save authorization in the operating-system credential store: {error}")
    })
}

fn delete_saved_token() -> Result<(), String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Could not remove the saved CannaBeats authorization: {error}"
        )),
    }
}

async fn api_json<T: DeserializeOwned>(
    response: Result<Response, reqwest::Error>,
) -> Result<T, ApiFailure> {
    let response = response.map_err(|error| ApiFailure {
        status: None,
        message: format!("Could not reach the CannaBeats service: {error}"),
    })?;
    let status = response.status();
    if status.is_success() {
        return response.json::<T>().await.map_err(|error| ApiFailure {
            status: Some(status),
            message: format!("CannaBeats returned an unreadable response: {error}"),
        });
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or_default();
    let message = body
        .get("error")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("CannaBeats request failed ({status})"));
    Err(ApiFailure {
        status: Some(status),
        message,
    })
}

async fn api_empty(response: Result<Response, reqwest::Error>) -> Result<(), ApiFailure> {
    let response = response.map_err(|error| ApiFailure {
        status: None,
        message: format!("Could not reach the CannaBeats service: {error}"),
    })?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or_default();
    let message = body
        .get("error")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("CannaBeats request failed ({status})"));
    Err(ApiFailure {
        status: Some(status),
        message,
    })
}

async fn active_token(state: &ClientState) -> Result<String, String> {
    state
        .token
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Connect this application first".to_owned())
}

#[tauri::command]
async fn bootstrap(state: State<'_, ClientState>) -> Result<BootstrapResponse, String> {
    let mut token = state.token.lock().await.clone();
    if token.is_none() {
        token = load_saved_token()?;
        *state.token.lock().await = token.clone();
    }
    let Some(token) = token else {
        return Ok(BootstrapResponse {
            origin: state.origin.clone(),
            authorized: false,
            user: None,
            application: None,
        });
    };
    let me = api_json::<MeResponse>(
        state
            .http
            .get(format!("{}/api/desktop/me", state.origin))
            .bearer_auth(&token)
            .send()
            .await,
    )
    .await;
    let me = match me {
        Ok(me) => me,
        Err(error) if error.status == Some(StatusCode::UNAUTHORIZED) => {
            *state.token.lock().await = None;
            delete_saved_token()?;
            return Ok(BootstrapResponse {
                origin: state.origin.clone(),
                authorized: false,
                user: None,
                application: None,
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    Ok(BootstrapResponse {
        origin: state.origin.clone(),
        authorized: true,
        user: Some(me.user),
        application: Some(me.application),
    })
}

#[tauri::command]
async fn begin_authorization(
    display_name: String,
    state: State<'_, ClientState>,
) -> Result<AuthorizationStartView, String> {
    let response = state
        .http
        .post(format!("{}/api/desktop/authorizations/start", state.origin))
        .json(&serde_json::json!({ "displayName": display_name }))
        .send()
        .await;
    let started = api_json::<AuthorizationStartResponse>(response)
        .await
        .map_err(|error| error.to_string())?;
    *state.pending.lock().await = Some(PendingAuthorization {
        token: started.authorization_token,
        verification_url: started.verification_url.clone(),
    });
    Ok(AuthorizationStartView {
        code: started.code,
        verification_url: started.verification_url,
        expires_at: started.expires_at,
    })
}

#[tauri::command]
async fn open_authorization_page(state: State<'_, ClientState>) -> Result<(), String> {
    let url = state
        .pending
        .lock()
        .await
        .as_ref()
        .map(|pending| pending.verification_url.clone())
        .ok_or_else(|| "Start desktop authorization first".to_owned())?;
    open::that(url).map_err(|error| format!("Could not open the default browser: {error}"))
}

#[tauri::command]
async fn open_account_page(state: State<'_, ClientState>) -> Result<(), String> {
    open::that(&state.origin)
        .map_err(|error| format!("Could not open the default browser: {error}"))
}

#[tauri::command]
async fn poll_authorization(
    state: State<'_, ClientState>,
) -> Result<AuthorizationStatusResponse, String> {
    let token = state
        .pending
        .lock()
        .await
        .as_ref()
        .map(|pending| pending.token.clone())
        .ok_or_else(|| "Start desktop authorization first".to_owned())?;
    let response = state
        .http
        .post(format!(
            "{}/api/desktop/authorizations/status",
            state.origin
        ))
        .json(&serde_json::json!({ "authorizationToken": token }))
        .send()
        .await;
    let status = api_json::<AuthorizationStatusResponse>(response)
        .await
        .map_err(|error| error.to_string())?;
    if status.status == "authorized" {
        save_token(&token)?;
        *state.token.lock().await = Some(token);
        *state.pending.lock().await = None;
    }
    Ok(status)
}

#[tauri::command]
async fn launch_game(
    code: Option<String>,
    app: AppHandle,
    state: State<'_, ClientState>,
) -> Result<(), String> {
    let token = active_token(&state).await?;
    let response = state
        .http
        .post(format!("{}/api/desktop/game-launch", state.origin))
        .bearer_auth(token)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await;
    let launch = api_json::<GameLaunchResponse>(response)
        .await
        .map_err(|error| error.to_string())?;
    let url = Url::parse(&launch.launch_url)
        .map_err(|_| "CannaBeats returned an invalid game URL".to_owned())?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The CannaBeats window is unavailable".to_owned())?;
    window
        .navigate(url)
        .map_err(|error| format!("Could not open the full game client: {error}"))
}

#[tauri::command]
async fn disconnect(state: State<'_, ClientState>) -> Result<(), String> {
    if let Some(token) = state.token.lock().await.clone() {
        let result = api_empty(
            state
                .http
                .request(
                    Method::DELETE,
                    format!("{}/api/desktop/session", state.origin),
                )
                .bearer_auth(token)
                .send()
                .await,
        )
        .await;
        if let Err(error) = result {
            if error.status != Some(StatusCode::UNAUTHORIZED) {
                return Err(error.to_string());
            }
        }
    }
    *state.token.lock().await = None;
    delete_saved_token()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let origin = configured_origin().expect("CannaBeats service origin must be valid");
    let state = ClientState {
        origin,
        http: Client::builder()
            .user_agent("CannaBeats-Desktop/0.1")
            .build()
            .expect("HTTP client must initialize"),
        token: Mutex::new(None),
        pending: Mutex::new(None),
    };
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            begin_authorization,
            open_authorization_page,
            open_account_page,
            poll_authorization,
            launch_game,
            disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the CannaBeats desktop client");
}
