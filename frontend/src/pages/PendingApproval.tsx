import { useLocation, useNavigate } from "react-router-dom";
import Lottie from "lottie-react";
import clockAnim from "@/assets/clock.json";
import logo from "@/assets/terralabs-logo.png";
import { Button } from "@/components/ui/button";

type PendingState = {
  course?: string;
  labName?: string;
  message?: string;
};

export default function PendingApproval() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state || {}) as PendingState;

  const course = state.course ?? "—";
  const labName = state.labName ?? "—";
  const message =
    state.message ?? "Please wait while Team Asgard approves this lab";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-xl text-center">
        {/* Header / brand */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <img src={logo} alt="TerraLabs" className="h-10" />
          <span className="text-xl font-semibold">TerraLabs</span>
        </div>

        {/* Lottie animation */}
        <div className="mx-auto w-64 sm:w-72 md:w-80">
          <Lottie animationData={clockAnim} loop autoplay />
        </div>

        {/* Message */}
        <h1 className="text-2xl font-bold mt-6">{message}</h1>
        <p className="text-muted-foreground mt-2">
          <span className="font-medium">Lab:</span> {labName} &nbsp;•&nbsp;
          <span className="font-medium">Course:</span> {course}
        </p>

        {/* Actions */}
        <div className="mt-8 flex items-center justify-center gap-3">
          <Button variant="outline" onClick={() => navigate(-1)}>
            Go Back
          </Button>
          <Button onClick={() => navigate("/running-labs")}>
            View Running Labs
          </Button>
        </div>

        {/* Small tip */}
        <p className="text-xs text-muted-foreground mt-4">
          You can leave this page; we’ll show the lab in <b>Running Labs</b>
          &nbsp;once resources are up.
        </p>
      </div>
    </div>
  );
}
