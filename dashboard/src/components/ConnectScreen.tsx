import { useState } from "preact/hooks";

interface Props {
  initialToken: string;
  error: string;
  onConnect: (token: string) => void;
}

export function ConnectScreen({ initialToken, error, onConnect }: Props) {
  const [value, setValue] = useState(initialToken);
  return (
    <div class="connect-screen">
      <div class="box">
        <h2>Connect to JARVIS</h2>
        <input
          type="password"
          placeholder="Dashboard token"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConnect(value.trim());
          }}
        />
        <button class="primary" onClick={() => onConnect(value.trim())}>
          Connect
        </button>
        {error && <div class="connect-error">{error}</div>}
      </div>
    </div>
  );
}
