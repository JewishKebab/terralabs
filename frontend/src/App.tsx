import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import Index from "./pages/Index";
import AuthPage from "./components/auth/AuthPage";
import Dashboard from "./pages/Dashboard";
import NotFound from "./pages/NotFound";
import RunningLabsPage from "./pages/RunningLabs";
import PendingApproval from "./pages/PendingApproval";
import TemplateVmPage from "./pages/TemplateVm";

import { MsalProvider } from "@azure/msal-react";
import { PublicClientApplication, Configuration, LogLevel } from "@azure/msal-browser";

const queryClient = new QueryClient();

// Read values injected by Vite (from vite.config define)
const AZURE_CLIENT_ID = (import.meta.env as any).AZURE_CLIENT_ID as string | undefined;
const AZURE_TENANT_ID = (import.meta.env as any).AZURE_TENANT_ID as string | undefined;

// Helpful console to verify values at runtime
if (!AZURE_CLIENT_ID || !AZURE_TENANT_ID) {
  console.error(
    "[MSAL] Missing env: AZURE_CLIENT_ID or AZURE_TENANT_ID. " +
      "Create /frontend/.env with those keys and restart the dev server."
  );
}

const msalConfig: Configuration = {
  auth: {
    // Do NOT send a placeholder. If undefined, MSAL will throw immediately instead of redirecting with a fake id.
    clientId: AZURE_CLIENT_ID ?? "",
    authority: AZURE_TENANT_ID
      ? `https://login.microsoftonline.com/${AZURE_TENANT_ID}`
      : "https://login.microsoftonline.com/common",
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback(level, message, containsPii) {
        if (containsPii) return;
        if (level === LogLevel.Error) console.error(message);
        if (level === LogLevel.Warning) console.warn(message);
      },
    },
  },
};

let pca: PublicClientApplication | null = null;
try {
  // Only construct if we have a client id; otherwise we’ll render without MSAL and the AAD button can be disabled.
  if (AZURE_CLIENT_ID) {
    pca = new PublicClientApplication(msalConfig);
  }
} catch (e) {
  console.error("[MSAL] Failed to initialize:", e);
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      {pca ? (
        <MsalProvider instance={pca}>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/auth" element={<AuthPage />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/labs" element={<RunningLabsPage />} />
              <Route path="/pending-approval" element={<PendingApproval />} />
              <Route path="/template-vm" element={<TemplateVmPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </MsalProvider>
      ) : (
        // Fallback render (still allows local/password auth). Your AuthPage should disable the AAD button if pca is null.
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/auth" element={<AuthPage />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/labs" element={<RunningLabsPage />} />
            <Route path="/pending-approval" element={<PendingApproval />} />
            <Route path="/template-vm" element={<TemplateVmPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      )}
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
