// src/pages/AuthAAD.tsx
import { useEffect } from "react";
import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { loginRequest } from "@/components/auth/msal";
import axios, { AxiosHeaders } from "axios";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import logo from "@/assets/terralabs-logo.png";

const API_BASE = "http://localhost:5000";

export default function AuthAAD() {
  const { instance, accounts } = useMsal();
  const isAuth = useIsAuthenticated();
  const navigate = useNavigate();

  // Start the Azure AD login redirect
  const signIn = async () => {
    await instance.loginRedirect(loginRequest);
  };

  // Sign out from MSAL + clear our app token
  const signOut = async () => {
    // MSAL logout (local)
    await instance.logoutRedirect();
    localStorage.removeItem("auth_token");
  };

  useEffect(() => {
    const go = async () => {
      // If our app already has a JWT, jump to dashboard
      const existing = localStorage.getItem("auth_token");
      if (existing) {
        navigate("/dashboard", { replace: true });
        return;
      }

      // Must be authenticated with MSAL and have an account
      if (!isAuth || accounts.length === 0) return;

      const account = accounts[0];

      // Get an ID token silently (no UI)
      const idResult = await instance.acquireTokenSilent({
        ...loginRequest,
        account,
      });

      const idToken = idResult?.idToken;
      if (!idToken) return;

      // Exchange the AAD ID token for your app JWT
      const api = axios.create({
        baseURL: API_BASE,
        headers: new AxiosHeaders({ "Content-Type": "application/json" }),
      });

      try {
        const res = await api.post("/api/aad/login", { id_token: idToken });
        const appToken: string | undefined = res?.data?.token;

        if (appToken) {
          localStorage.setItem("auth_token", appToken);
          navigate("/dashboard", { replace: true });
        }
      } catch (e) {
        // If exchange fails, keep user on login page
        console.error("AAD exchange failed:", e);
      }
    };

    // Only try after MSAL has an account
    go().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuth, accounts]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="bg-[#1a1a1a] px-6 py-3 rounded-lg inline-block">
          <img src={logo} alt="TerraLabs" className="h-8" />
        </div>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-muted-foreground">
          Use your Microsoft account to continue.
        </p>
        <div className="space-y-3">
          <Button className="w-full" onClick={signIn}>
            Sign in with Microsoft
          </Button>
          {isAuth && (
            <Button className="w-full" variant="outline" onClick={signOut}>
              Sign out
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
