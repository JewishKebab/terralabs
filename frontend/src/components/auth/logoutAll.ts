import { Configuration } from "@azure/msal-browser";

// read from window globals or environment vars
const clientId =
  (window as any).AAD_CLIENT_ID ||
  import.meta.env.VITE_AAD_CLIENT_ID ||
  "";
const tenantId =
  (window as any).AAD_TENANT_ID ||
  import.meta.env.VITE_AAD_TENANT_ID ||
  "";

if (!clientId || !tenantId) {
  console.warn(
    "[MSAL] Missing AAD_CLIENT_ID or AAD_TENANT_ID — check index.html or .env"
  );
}

// core config
export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri: `${window.location.origin}/auth`,
    postLogoutRedirectUri: `${window.location.origin}/auth`,
  },
  cache: {
    cacheLocation: "localStorage", // persist login
    storeAuthStateInCookie: false, // only needed for IE11
  },
};

// scopes to request when logging in
export const loginRequest = {
  scopes: ["openid", "profile", "email"],
};
