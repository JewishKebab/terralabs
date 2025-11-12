// src/hooks/useFullLogout.ts
import { useMsal } from "@azure/msal-react";

/**
 * Logs user out of AAD (server-side) first, then falls back if needed.
 * We only clear app-local state before the redirect; deep MSAL cache cleanup
 * is done on /auth after we land back (see AuthPage patch below).
 */
export function useFullLogout() {
  const { instance } = useMsal();

  const logout = async () => {
    // 1) Clear your app's local tokens/state (safe pre-redirect)
    try {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("aad_role");
      localStorage.removeItem("aad_course");
      localStorage.removeItem("aad_section");
      localStorage.removeItem("aad_groups");
      Object.keys(localStorage)
        .filter((k) => k.startsWith("template_vm_session"))
        .forEach((k) => localStorage.removeItem(k));
      sessionStorage.removeItem("tl_aad_logging_in");
    } catch {
      /* ignore */
    }

    // 2) Redirect logout using the active account (don’t remove accounts yet)
    try {
      const active = instance.getActiveAccount?.() ?? undefined;
      await instance.logoutRedirect({
        account: active,
        postLogoutRedirectUri: `${window.location.origin}/auth`,
      });
      return; // will navigate away
    } catch (err) {
      console.warn("logoutRedirect failed, trying popup:", err);
      try {
        const active = instance.getActiveAccount?.() ?? undefined;
        await instance.logoutPopup({
          account: active,
          postLogoutRedirectUri: `${window.location.origin}/auth`,
        });
        return;
      } catch (err2) {
        console.warn("logoutPopup failed, hard redirect:", err2);
      }
    }

    // 3) Final hard redirect if everything else failed
    window.location.replace("/auth");
  };

  return logout;
}

export default useFullLogout;
