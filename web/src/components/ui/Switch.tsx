import { useId } from "react";

interface Props {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}

export function Switch({ label, checked, onChange, hint, disabled }: Props) {
  const id = useId();
  return (
    <div className="switch-row">
      <div>
        <label htmlFor={id}>{label}</label>
        {hint && <p className="hint">{hint}</p>}
      </div>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}
