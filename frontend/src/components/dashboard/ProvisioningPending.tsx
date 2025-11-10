import Lottie from "lottie-react";
import clockAnim from "@/assets/clock.json";

export default function ProvisioningPending({
  course,
  labName,
}: {
  course: string;
  labName: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16">
      <div className="w-64 sm:w-80 mb-6">
        <Lottie animationData={clockAnim} loop autoplay />
      </div>

      <h1 className="text-2xl font-bold mb-2">
        Please wait while Team Asgard approves this lab
      </h1>
      <p className="text-muted-foreground text-sm">
        Lab <span className="font-semibold">{labName}</span> from{" "}
        <span className="font-semibold">{course}</span> is being processed...
      </p>

      <p className="text-xs text-muted-foreground mt-4">
        This may take a few minutes. You can check progress under{" "}
        <span className="font-medium">Running Labs</span> once ready.
      </p>
    </div>
  );
}
