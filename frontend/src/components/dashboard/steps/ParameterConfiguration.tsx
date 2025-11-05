// frontend/src/components/dashboard/steps/ParameterConfiguration.tsx
import WindowsSnapshotParams from "./WindowsSnapshotParams";

type Props = {
  course: string;
  labName: string;
  selectedModule: string; // expect "WindowsSnapshot"
  onBack: () => void;
  onDone: (res: any) => void;
};

export default function ParameterConfiguration({
  course,
  labName,
  selectedModule,
  onBack,
  onDone,
}: Props) {
  if (selectedModule === "WindowsSnapshot") {
    return (
      <WindowsSnapshotParams
        course={course}
        labName={labName}
        onBack={onBack}
        onDone={onDone}
      />
    );
  }

  return (
    <div className="text-sm text-muted-foreground">
      Select the <b>Snapshot Virtual Machine</b> module to configure parameters.
    </div>
  );
}
