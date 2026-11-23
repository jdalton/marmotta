//! Self-loading trampoline for compressed `.node` addons. Node loads the stub,
//! which resolves the embedded addon and forwards N-API registration.

use std::ffi::{c_void, CStr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

type NapiEnv = *mut c_void;
type NapiValue = *mut c_void;
type RegisterFn = unsafe extern "C" fn(NapiEnv, NapiValue) -> NapiValue;
const DEFAULT_API_VERSION: i32 = 8;

#[derive(Clone, Copy)]
struct LoadedAddon {
  register: RegisterFn,
  api_version: i32,
}

static ADDON: Mutex<Option<LoadedAddon>> = Mutex::new(None);

fn prepare_inner_addon() -> Result<LoadedAddon, &'static CStr> {
  let mut loaded = ADDON.lock().unwrap_or_else(|error| error.into_inner());
  if let Some(addon) = *loaded {
    return Ok(addon);
  }
  let addon = unsafe { trampoline() }?;
  *loaded = Some(addon);
  Ok(addon)
}

/// Node calls this before creating an environment, so the value must come from
/// the loaded addon itself. Addons that do not export it use Node-API version 8.
#[no_mangle]
pub extern "C" fn node_api_module_get_api_version_v1() -> i32 {
  prepare_inner_addon().map_or(DEFAULT_API_VERSION, |addon| addon.api_version)
}

unsafe fn throw_init_error(env: NapiEnv, message: &CStr) {
  #[cfg(unix)]
  {
    type ThrowError =
      unsafe extern "C" fn(NapiEnv, *const std::ffi::c_char, *const std::ffi::c_char) -> i32;
    let function = libc::dlsym(libc::RTLD_DEFAULT, c"napi_throw_error".as_ptr());
    if !function.is_null() {
      let function: ThrowError = std::mem::transmute(function);
      function(env, std::ptr::null(), message.as_ptr());
    }
  }
  #[cfg(windows)]
  {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    type ThrowError =
      unsafe extern "C" fn(NapiEnv, *const std::ffi::c_char, *const std::ffi::c_char) -> i32;
    for host in [
      std::ptr::null(),
      windows_sys::w!("libnode.dll"),
      windows_sys::w!("node.dll"),
    ] {
      let module = GetModuleHandleW(host);
      if module.is_null() {
        continue;
      }
      if let Some(function) = GetProcAddress(module, c"napi_throw_error".as_ptr().cast()) {
        let function: ThrowError = std::mem::transmute(function);
        function(env, std::ptr::null(), message.as_ptr());
        return;
      }
    }
  }
}

/// Node's entry point for a native addon.
///
/// # Safety
/// Called by Node with a valid env/exports during module load.
#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
  match prepare_inner_addon() {
    Ok(addon) => (addon.register)(env, exports),
    Err(error) => {
      throw_init_error(env, error);
      std::ptr::null_mut()
    }
  }
}

unsafe fn trampoline() -> Result<LoadedAddon, &'static CStr> {
  let stub = own_path().ok_or(c"cannot locate compressed addon stub")?;
  // Resolve the embedded payload to a cached addon. On Btrfs, the carrier is also
  // replaced for future processes.
  let loadable = napi_native_addon::resolve_self(&stub)
    .ok_or(c"cannot prepare embedded addon from compressed payload")?;
  let (register, version) = load_register(&loadable)
    .ok_or(c"prepared addon does not export napi_register_module_v1 or could not be loaded")?;
  napi_native_addon::cleanup_after_load(&loadable);
  Ok(LoadedAddon {
    register,
    api_version: version.unwrap_or(DEFAULT_API_VERSION),
  })
}

#[cfg(unix)]
unsafe fn own_path() -> Option<PathBuf> {
  use std::os::unix::ffi::OsStrExt;
  let mut info: libc::Dl_info = std::mem::zeroed();
  if libc::dladdr(napi_register_module_v1 as *const c_void, &mut info) == 0
    || info.dli_fname.is_null()
  {
    return None;
  }
  let bytes = std::ffi::CStr::from_ptr(info.dli_fname).to_bytes();
  Some(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

#[cfg(unix)]
unsafe fn load_register(path: &Path) -> Option<(RegisterFn, Option<i32>)> {
  use std::os::unix::ffi::OsStrExt;
  let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
  // Match Node's default process.dlopen behavior. Eager relocation can make large
  // addons spend significant startup time resolving symbols that are never used.
  let handle = libc::dlopen(cpath.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
  if handle.is_null() {
    return None;
  }
  let sym = libc::dlsym(handle, c"napi_register_module_v1".as_ptr());
  if sym.is_null() {
    return None;
  }
  let version_symbol = libc::dlsym(handle, c"node_api_module_get_api_version_v1".as_ptr());
  let version = if version_symbol.is_null() {
    None
  } else {
    let getter: unsafe extern "C" fn() -> i32 = std::mem::transmute(version_symbol);
    Some(getter())
  };
  Some((std::mem::transmute::<*mut c_void, RegisterFn>(sym), version))
}

#[cfg(windows)]
unsafe fn own_path() -> Option<PathBuf> {
  use std::os::windows::ffi::OsStringExt;

  use windows_sys::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
  };

  let mut module = std::ptr::null_mut();
  let ok = GetModuleHandleExW(
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    napi_register_module_v1 as *const u16,
    &mut module,
  );
  if ok == 0 {
    return None;
  }
  let mut buf = [0u16; 32768];
  let len = GetModuleFileNameW(module, buf.as_mut_ptr(), buf.len() as u32);
  if len == 0 {
    return None;
  }
  Some(PathBuf::from(std::ffi::OsString::from_wide(
    &buf[..len as usize],
  )))
}

#[cfg(windows)]
unsafe fn load_register(path: &Path) -> Option<(RegisterFn, Option<i32>)> {
  use std::os::windows::ffi::OsStrExt;

  use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

  let wide: Vec<u16> = path
    .as_os_str()
    .encode_wide()
    .chain(std::iter::once(0))
    .collect();
  let module = LoadLibraryW(wide.as_ptr());
  if module.is_null() {
    return None;
  }
  let proc = GetProcAddress(module, c"napi_register_module_v1".as_ptr().cast())?;
  let version_proc = GetProcAddress(
    module,
    c"node_api_module_get_api_version_v1".as_ptr().cast(),
  );
  let version = version_proc.map(|function| {
    let getter: unsafe extern "C" fn() -> i32 = std::mem::transmute(function);
    getter()
  });
  Some((
    std::mem::transmute::<unsafe extern "system" fn() -> isize, RegisterFn>(proc),
    version,
  ))
}
