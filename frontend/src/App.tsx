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

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/labs" element={<RunningLabsPage />} />
          <Route path="/pending-approval" element={<PendingApproval />} /> 
            <Route path="/template-vm" element={<TemplateVmPage />} /> 

          {/* Catch-all 404 last */}
          
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
