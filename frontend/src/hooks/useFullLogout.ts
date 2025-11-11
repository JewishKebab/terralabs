import { useMsal } from "@azure/msal-react";

/**
 * Centralized logout hook — clears local tokens and MSAL cache.
 * Use this in any page or header that has a Logout button.
 */
export function useFullLogout() {
  const { instance, accounts } = useMsal();

  const logout = async () => {
    try {
      // Clear your app token and any per-user local state
      localStorage.removeItem("auth_token");
      Object.keys(localStorage)
        .filter((k) => k.startsWith("template_vm_session"))
        .forEach((k) => localStorage.removeItem(k));

      const account = instance.getActiveAccount() || accounts[0];

      if (account) {
        await instance.logoutRedirect({
          account,
          postLogoutRedirectUri: `${window.location.origin}/auth`,
        });
      } else {
        window.location.replace("/auth");
      }
    } catch (err) {
      console.error("[Logout error]", err);
      window.location.replace("/auth");
    }
  };

  return logout;
}
