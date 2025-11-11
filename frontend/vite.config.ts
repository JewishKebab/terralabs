import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

export default defineConfig(({ mode }) => {
  // Load every env key (third arg = "" -> don’t filter by VITE_)
  const env = loadEnv(mode, process.cwd(), "");

  return {
    server: { host: "::", port: 8080 },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },
    define: {
      "import.meta.env.AZURE_CLIENT_ID": JSON.stringify(env.AZURE_CLIENT_ID),
      "import.meta.env.AZURE_TENANT_ID": JSON.stringify(env.AZURE_TENANT_ID),
    },
  };
});
