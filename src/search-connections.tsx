import { ActionPanel, Action, Icon, List, getPreferenceValues, showToast, Toast } from "@raycast/api";
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

function decodeSessionKey(encoded: string): string {
  try {
    // PuTTY stores session key names URL-encoded in the registry
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
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
              <Action.CopyToClipboard title="Copy Session Name" content={s.name} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
