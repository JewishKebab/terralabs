// src/App.tsx
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import Index from "./pages/Index";
import AuthPage from "./components/auth/AuthPage";           // ensure correct path
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

if (!AZURE_CLIENT_ID || !AZURE_TENANT_ID) {
  console.error(
    "[MSAL] Missing env: AZURE_CLIENT_ID or AZURE_TENANT_ID. Create /frontend/.env with those keys and restart the dev server."
  );
}

const msalConfig: Configuration = {
  auth: {
    clientId: AZURE_CLIENT_ID ?? "",
    authority: AZURE_TENANT_ID
      ? `https://login.microsoftonline.com/${AZURE_TENANT_ID}`
      : "https://login.microsoftonline.com/common",
    // Send the redirect back to the Auth page where the exchange runs
    redirectUri: `${window.location.origin}/auth`,
    postLogoutRedirectUri: `${window.location.origin}/auth`,
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

// Build PCA if client id exists
let pca: PublicClientApplication | null = null;
try {
  if (AZURE_CLIENT_ID) {
    pca = new PublicClientApplication(msalConfig);
  }
} catch (e) {
  console.error("[MSAL] Failed to construct PublicClientApplication:", e);
  pca = null;
}

function RoutesOnly() {
  return (
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
  );
}

const App = () => {
  // Gate rendering of MsalProvider until pca.initialize() completes
  const [msalReady, setMsalReady] = useState<boolean>(() => (pca ? false : true));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pca) {
        setMsalReady(true);
        return;
      }
      try {
        await pca.initialize();
        if (!cancelled) setMsalReady(true);
      } catch (err) {
        console.error("[MSAL] initialize() failed:", err);
        // Even if MSAL init failed, allow app to render without MSAL so local auth still works.
        if (!cancelled) setMsalReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />

        {/* If we don't have a PCA (no client id), render without MSAL */}
        {!pca ? (
          <RoutesOnly />
        ) : msalReady ? (
          <MsalProvider instance={pca}>
            <RoutesOnly />
          </MsalProvider>
        ) : (
          // Lightweight fallback while MSAL initializes (avoid calling MSAL APIs before ready)
          <div className="min-h-screen flex items-center justify-center">
            <div className="text-sm text-muted-foreground">Initializing Microsoft login…</div>
          </div>
        )}
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
