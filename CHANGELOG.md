# Changelog

DevJack uses odd minor versions for pre-releases (0.1.x) and even minor versions for stable releases (0.2.x).

## 0.1.0 (pre-release)

The first public pre-release of DevJack 2.

- **Plug and play.** Connects to Claude Code on first start, with nothing to install or configure.
  - It works with the Claude Code extension and with `claude` in the integrated terminal, including terminals that were open before DevJack was installed.
  - The hooks need no Node.js and no Git: `powershell.exe` on Windows, `sh` on macOS and Linux.
- **The table follows Claude.**
  - It opens after Claude has worked for 2.5 s, and says when Claude needs a permission decision or an answer (**Go to Claude**).
  - It lets you finish your hand when Claude is done, and closes on Esc, on the Stop button and on API errors.
- **Full Blackjack.** A 6-deck shoe with a cut card, 3:2 blackjack, dealer peek, insurance, double (also after a split) and up to 4 split hands, with the dealer standing on soft 17 or hitting it. There's a free rebuy, and the stats are in the menu.
- **Made for a side panel.**
  - Original SVG cards and chips, and three felt colors.
  - Keyboard play, screen reader announcements and reduced-motion support.
  - No CPU use while idle.
- **Diagnostics:** **Check Claude Connection** with a self-test, a log that never contains prompt content, and **Simulate Claude Run**.
- Works in VS Code 1.94 or later, including WSL and other remote windows (DevJack runs on the remote side, next to Claude Code). VS Code for the Web is not supported.
- Published to the VS Code Marketplace. For Cursor, Windsurf and VSCodium, install the `.vsix` from the GitHub Release (Open VSX comes later).
