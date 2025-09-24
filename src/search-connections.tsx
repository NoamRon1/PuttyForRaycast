import { ActionPanel, Action, Icon, List, getPreferenceValues, showToast, Toast, Keyboard, Form, popToRoot, closeMainWindow } from "@raycast/api";
import { useEffect, useState } from "react";
import { exec, execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

type Preferences = {
  puttyPath: string;
};

type PuttySession = {
  id: string;
  name: string;
};

type Protocol = "raw" | "telnet" | "rlogin" | "ssh" | "serial";
type CloseOnExit = "always" | "never" | "onexit";

function decodeSessionKey(encoded: string): string {
  try {
    // PuTTY stores session key names URL-encoded in the registry
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function encodeSessionKey(raw: string): string {
  return encodeURIComponent(raw);
}

async function listPuttySessions(): Promise<PuttySession[]> {
  const registryKey = "HKCU\\Software\\SimonTatham\\PuTTY\\Sessions";
  return new Promise((resolve) => {
    exec(`reg query "${registryKey}"`, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const lines = stdout.split(/\r?\n/).map((l) => l.trim());
      const sessions: PuttySession[] = [];
      for (const line of lines) {
        if (line.startsWith("HKEY_")) {
          const match = line.match(/Sessions\\(.+)$/);
          if (match && match[1]) {
            const id = match[1];
            const name = decodeSessionKey(id);
            sessions.push({ id, name });
          }
        }
      }
      resolve(sessions.sort((a, b) => a.name.localeCompare(b.name)));
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    try {
      // On Windows, X_OK may not be enforced. Check for readability instead.
      await access(path, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

async function readSessionValues(sessionName: string): Promise<{ HostName: string; PortNumber: number; Protocol: Protocol; CloseOnExit: CloseOnExit; }> {
  return new Promise((resolve) => {
    const key = `HKCU\\Software\\SimonTatham\\PuTTY\\Sessions\\${encodeSessionKey(sessionName)}`;
    exec(`reg query "${key}"`, (error, stdout) => {
      const defaults = { HostName: "", PortNumber: 23, Protocol: "raw" as Protocol, CloseOnExit: "onexit" as CloseOnExit };
      if (error) {
        resolve(defaults);
        return;
      }
      let HostName = defaults.HostName;
      let PortNumber = defaults.PortNumber;
      let Protocol: Protocol = defaults.Protocol;
      let CloseOnExit: CloseOnExit = defaults.CloseOnExit;
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s+REG_[A-Z0-9_]+\s+(.+)$/);
        if (!m) continue;
        const name = m[1];
        const value = m[2].trim();
        if (name === "HostName") HostName = value;
        if (name === "PortNumber") {
          if (/^0x/i.test(value)) PortNumber = parseInt(value, 16);
          else PortNumber = parseInt(value, 10);
        }
        if (name === "Protocol") Protocol = value as Protocol;
        if (name === "CloseOnExit") CloseOnExit = value as CloseOnExit;
      }
      resolve({ HostName, PortNumber, Protocol, CloseOnExit });
    });
  });
}

function writeRegistryValues(sessionName: string, values: { HostName: string; PortNumber: number; Protocol: Protocol; CloseOnExit: CloseOnExit; }) {
  return new Promise<void>((resolve, reject) => {
    const baseKey = `HKCU\\Software\\SimonTatham\\PuTTY\\Sessions\\${encodeSessionKey(sessionName)}`;
    exec(`reg add "${baseKey}" /f`, (err) => {
      if (err) {
        reject(err);
        return;
      }
      const commands = [
        `reg add "${baseKey}" /v HostName /t REG_SZ /d "${values.HostName}" /f`,
        `reg add "${baseKey}" /v PortNumber /t REG_DWORD /d ${values.PortNumber} /f`,
        `reg add "${baseKey}" /v Protocol /t REG_SZ /d ${values.Protocol} /f`,
        `reg add "${baseKey}" /v CloseOnExit /t REG_SZ /d ${values.CloseOnExit} /f`,
      ];
      let index = 0;
      const runNext = () => {
        if (index >= commands.length) {
          resolve();
          return;
        }
        const cmd = commands[index++];
        exec(cmd, (err2) => {
          if (err2) {
            reject(err2);
            return;
          }
          runNext();
        });
      };
      runNext();
    });
  });
}

function EditConnectionForm(props: { sessionName: string; puttyPath: string; onUpdated?: () => void }) {
  const { sessionName, puttyPath, onUpdated } = props;
  const [initial, setInitial] = useState<{ HostName: string; PortNumber: number; Protocol: Protocol; CloseOnExit: CloseOnExit } | null>(null);
  useEffect(() => {
    (async () => {
      const vals = await readSessionValues(sessionName);
      setInitial(vals);
    })();
  }, [sessionName]);

  async function handleSubmit(values: { host: string; port: string; protocol: Protocol; closeOnExit: CloseOnExit }) {
    const portNum = Number(values.port);
    if (!values.host) {
      await showToast({ style: Toast.Style.Failure, title: "Host is required" });
      return;
    }
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      await showToast({ style: Toast.Style.Failure, title: "Invalid port" });
      return;
    }
    try {
      await writeRegistryValues(sessionName, { HostName: values.host, PortNumber: portNum, Protocol: values.protocol, CloseOnExit: values.closeOnExit });
      await showToast({ style: Toast.Style.Success, title: "Session updated", message: sessionName });
      const exists = await fileExists(puttyPath);
      if (!exists) {
        await showToast({ style: Toast.Style.Failure, title: "PuTTY path not found", message: puttyPath });
      } else {
        execFile(puttyPath, ["-load", sessionName], (error) => {
          if (error) {
            showToast({ style: Toast.Style.Failure, title: "Failed to launch PuTTY", message: error.message });
          }
        });
      }
      if (onUpdated) onUpdated();
      try {
        await popToRoot({ clearSearchBar: true });
      } catch {}
      try {
        await closeMainWindow({ clearRootSearch: true } as any);
      } catch {}
    } catch (e: any) {
      await showToast({ style: Toast.Style.Failure, title: "Failed to update session", message: e?.message });
    }
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Changes" icon={Icon.Check} onSubmit={handleSubmit as any} />
        </ActionPanel>
      }
    >
      <Form.TextField id="host" title="Host name (or IP)" defaultValue={initial?.HostName} />
      <Form.TextField id="port" title="Port" defaultValue={initial ? String(initial.PortNumber) : ""} />
      <Form.Dropdown id="protocol" title="Connection type" defaultValue={initial?.Protocol || "raw"}>
        <Form.Dropdown.Item title="Raw" value="raw" />
        <Form.Dropdown.Item title="Telnet" value="telnet" />
        <Form.Dropdown.Item title="Rlogin" value="rlogin" />
        <Form.Dropdown.Item title="SSH" value="ssh" />
        <Form.Dropdown.Item title="Serial" value="serial" />
      </Form.Dropdown>
      <Form.Dropdown id="closeOnExit" title="Close window on exit" defaultValue={initial?.CloseOnExit || "onexit"}>
        <Form.Dropdown.Item title="Always" value="always" />
        <Form.Dropdown.Item title="Never" value="never" />
        <Form.Dropdown.Item title="Only on clean exit" value="onexit" />
      </Form.Dropdown>
    </Form>
  );
}

function TempEditForm(props: { sessionName: string; puttyPath: string }) {
  const { sessionName, puttyPath } = props;
  const [initial, setInitial] = useState<{ HostName: string; PortNumber: number; Protocol: Protocol; CloseOnExit: CloseOnExit } | null>(null);
  useEffect(() => {
    (async () => {
      const vals = await readSessionValues(sessionName);
      setInitial(vals);
    })();
  }, [sessionName]);

  function protocolToFlag(p: Protocol): string {
    switch (p) {
      case "ssh":
        return "-ssh";
      case "telnet":
        return "-telnet";
      case "rlogin":
        return "-rlogin";
      case "serial":
        return "-serial";
      case "raw":
      default:
        return "-raw";
    }
  }

  async function handleSubmit(values: { host: string; port: string; protocol: Protocol; closeOnExit: CloseOnExit }) {
    const portNum = Number(values.port);
    if (!values.host) {
      await showToast({ style: Toast.Style.Failure, title: "Host is required" });
      return;
    }
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      await showToast({ style: Toast.Style.Failure, title: "Invalid port" });
      return;
    }

    const exists = await fileExists(puttyPath);
    if (!exists) {
      await showToast({ style: Toast.Style.Failure, title: "PuTTY path not found", message: puttyPath });
      return;
    }

    const args = [protocolToFlag(values.protocol), "-P", String(portNum), values.host];
    execFile(puttyPath, args, (error) => {
      if (error) {
        showToast({ style: Toast.Style.Failure, title: "Failed to launch PuTTY", message: error.message });
      }
    });

    try {
      await popToRoot({ clearSearchBar: true });
    } catch {}
    try {
      await closeMainWindow({ clearRootSearch: true } as any);
    } catch {}
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Open Without Saving" icon={Icon.Goal} onSubmit={handleSubmit as any} />
        </ActionPanel>
      }
    >
      <Form.TextField id="host" title="Host name (or IP)" defaultValue={initial?.HostName} />
      <Form.TextField id="port" title="Port" defaultValue={initial ? String(initial.PortNumber) : ""} />
      <Form.Dropdown id="protocol" title="Connection type" defaultValue={initial?.Protocol || "raw"}>
        <Form.Dropdown.Item title="Raw" value="raw" />
        <Form.Dropdown.Item title="Telnet" value="telnet" />
        <Form.Dropdown.Item title="Rlogin" value="rlogin" />
        <Form.Dropdown.Item title="SSH" value="ssh" />
        <Form.Dropdown.Item title="Serial" value="serial" />
      </Form.Dropdown>
      <Form.Dropdown id="closeOnExit" title="Close window on exit" defaultValue={initial?.CloseOnExit || "onexit"}>
        <Form.Dropdown.Item title="Always" value="always" />
        <Form.Dropdown.Item title="Never" value="never" />
        <Form.Dropdown.Item title="Only on clean exit" value="onexit" />
      </Form.Dropdown>
    </Form>
  );
}

export default function Command() {
  const { puttyPath } = getPreferenceValues<Preferences>();
  const [sessions, setSessions] = useState<PuttySession[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setIsLoading(true);
      const exists = await fileExists(puttyPath);
      if (!exists) {
        await showToast({
          style: Toast.Style.Failure,
          title: "PuTTY path not found",
          message: puttyPath,
        });
      }
      const list = await listPuttySessions();
      if (mounted) {
        setSessions(list);
        setIsLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [puttyPath]);

  const launchSession = async (sessionName: string) => {
    const exists = await fileExists(puttyPath);
    if (!exists) {
      await showToast({ style: Toast.Style.Failure, title: "PuTTY path not found", message: puttyPath });
      return;
    }
    execFile(puttyPath, ["-load", sessionName], (error) => {
      if (error) {
        showToast({ style: Toast.Style.Failure, title: "Failed to launch PuTTY", message: error.message });
      }
    });
  };

  const deleteSession = async (sessionName: string) => {
    return new Promise<void>((resolve) => {
      const registryKey = `HKCU\\Software\\SimonTatham\\PuTTY\\Sessions\\${encodeSessionKey(sessionName)}`;
      exec(`reg delete "${registryKey}" /f`, async (error) => {
        if (error) {
          await showToast({ style: Toast.Style.Failure, title: "Failed to delete session", message: sessionName });
        } else {
          await showToast({ style: Toast.Style.Success, title: "Deleted", message: sessionName });
          setSessions((prev) => prev.filter((s) => s.name !== sessionName));
        }
        resolve();
      });
    });
  };

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search PuTTY sessions…">
      {sessions.map((s) => (
        <List.Item
          key={s.id}
          icon={Icon.Terminal}
          title={s.name}
          accessories={[{ text: s.name }]}
          actions={
            <ActionPanel>
              <Action
                title="Open in PuTTY"
                icon={Icon.Play}
                onAction={() => launchSession(s.name)}
              />
              <Action.Push
                title="Temporary Edit and Open"
                icon={Icon.Goal}
                target={<TempEditForm sessionName={s.name} puttyPath={puttyPath} />}
                shortcut={Keyboard.Shortcut.Common.OpenWith}
              />
              <Action.Push
                title="Edit Connection"
                icon={Icon.Pencil}
                target={<EditConnectionForm sessionName={s.name} puttyPath={puttyPath} onUpdated={() => { /* no-op */ }} />}
                shortcut={Keyboard.Shortcut.Common.Edit}
              />
              <Action
                title="Delete Connection"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={() => deleteSession(s.name)}
                shortcut={Keyboard.Shortcut.Common.Remove}
              />
              <Action.CopyToClipboard title="Copy Session Name" content={s.name} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
