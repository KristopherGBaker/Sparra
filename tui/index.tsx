import React from "react";
import { render, Box, Text } from "ink";
import { loadCtx } from "../src/context.ts";
import App from "./App.tsx";

async function main() {
  if (!process.stdin.isTTY) {
    process.stderr.write("The Sparra TUI needs an interactive terminal (TTY). Run it directly: `sparra-tui` (or `npm run tui`).\n");
    process.exitCode = 1;
    return;
  }
  const rootArg = process.argv.indexOf("--root");
  const root = rootArg >= 0 ? process.argv[rootArg + 1]! : process.cwd();

  let ctx;
  try {
    ctx = await loadCtx(root);
  } catch (e) {
    render(
      <Box flexDirection="column" padding={1}>
        <Text color="red">Could not open Sparra project at {root}</Text>
        <Text dimColor>{(e as Error).message}</Text>
        <Text dimColor>Run `sparra init` there first.</Text>
      </Box>
    );
    process.exitCode = 1;
    return;
  }

  render(<App ctx={ctx} />);
}

main();
