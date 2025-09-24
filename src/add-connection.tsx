import { Action, ActionPanel, Form, Icon, Toast, showToast, getPreferenceValues, popToRoot, closeMainWindow } from "@raycast/api";
import { exec, execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

type Preferences = {
  puttyPath: string;
};

type Protocol = "raw" | "telnet" | "rlogin" | "ssh" | "serial";

type CloseOnExit = "always" | "never" | "onexit";

function encodeSessionKey(raw: string): string {
  // Use encodeURIComponent to match PuTTY's session key encoding
  return encodeURIComponent(raw);
}

function writeRegistryValues(sessionName: string, values: { HostName: string; PortNumber: number; Protocol: Protocol; CloseOnExit: CloseOnExit; }) {
  return new Promise<void>((resolve, reject) => {
    const baseKey = `HKCU\\Software\\SimonTatham\\PuTTY\\Sessions\\${encodeSessionKey(sessionName)}`;
    // Create the session key
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    try {
      await access(path, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export default function Command() {
  const { puttyPath } = getPreferenceValues<Preferences>();
  async function handleSubmit(values: {
    host: string;
    port: string;
    protocol: Protocol;
    closeOnExit: CloseOnExit;
    save: boolean;
    savedName?: string;
  }) {
    const portNum = Number(values.port);
    if (!values.host) {
      await showToast({ style: Toast.Style.Failure, title: "Host is required" });
      return;
    }
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      await showToast({ style: Toast.Style.Failure, title: "Invalid port" });
      return;
    }

    const sessionName = (values.save ? (values.savedName?.trim() || values.host.trim()) : "").trim();

    if (values.save) {
      try {
        await writeRegistryValues(sessionName, {
          HostName: values.host,
          PortNumber: portNum,
          Protocol: values.protocol,
          CloseOnExit: values.closeOnExit,
        });
        await showToast({ style: Toast.Style.Success, title: "Session saved", message: sessionName });
        // Launch saved session immediately
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
        // Dismiss the form after launching
        try {
          await popToRoot({ clearSearchBar: true });
        } catch {}
        try {
          await closeMainWindow({ clearRootSearch: true } as any);
        } catch {}
      } catch (e: any) {
        await showToast({ style: Toast.Style.Failure, title: "Failed to save session", message: e?.message });
        return;
      }
    }
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Connection" icon={Icon.Plus} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="host" title="Host name (or IP)" placeholder="example.com" autoFocus />
      <Form.TextField id="port" title="Port" placeholder="23 for Telnet, 22 for SSH, etc." defaultValue="23" />
      <Form.Dropdown id="protocol" title="Connection type" defaultValue="raw">
        <Form.Dropdown.Item title="Raw" value="raw" />
        <Form.Dropdown.Item title="Telnet" value="telnet" />
        <Form.Dropdown.Item title="Rlogin" value="rlogin" />
        <Form.Dropdown.Item title="SSH" value="ssh" />
        <Form.Dropdown.Item title="Serial" value="serial" />
      </Form.Dropdown>
      <Form.Dropdown id="closeOnExit" title="Close window on exit" defaultValue="onexit">
        <Form.Dropdown.Item title="Always" value="always" />
        <Form.Dropdown.Item title="Never" value="never" />
        <Form.Dropdown.Item title="Only on clean exit" value="onexit" />
      </Form.Dropdown>
      <Form.Separator />
      <Form.Checkbox id="save" label="Save session" defaultValue={true} />
      <Form.TextField id="savedName" title="Saved name" placeholder="Defaults to host" />
    </Form>
  );
}


