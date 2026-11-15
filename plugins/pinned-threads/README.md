# Pinned Threads

Keep threads from any channel one click away. Right-click a thread tab and
choose **Pin thread**. The thread then shows as a tab on its own row, below
the title bar and above the window, on every page. Click a pinned tab to
open its thread, even when it's in another channel or the sidebar is
collapsed.

> **Waiting on Buzz.** The row under the title bar and **Pin thread** in the
> thread tab menu, as in the [mockups](#mockups), need
> [block/buzz-app#3580](https://github.com/block/buzz-app/pull/3580). Until a
> Buzz release includes it, the pinned tabs sit right of Search and **Pin
> thread** is in a message's **…** menu. See [Requirements](#requirements).

- A pinned tab shows unread the way the sidebar does: a bold title, plus a
  dot for mentions and replies. Three dots mean an agent is working in the
  thread.
- Right-click a pinned tab (or press Shift+F10) to **Rename** it in place
  (Enter saves, Esc cancels, an empty name goes back to the thread's title),
  pick a **Color** for its icon (None plus 8 colours), or **Unpin** it.
- Tabs shrink to 9rem wide. After that, a **+N** button lists the rest.
- With nothing pinned, the row is hidden. A thread that's already pinned
  shows **Unpin thread** in its tab menu instead.

Pins are kept in this Mac's local storage for each community and account.
Only the current community's pins are shown.

## Requirements

The layout above, the one in the mockups, needs
[block/buzz-app#3580](https://github.com/block/buzz-app/pull/3580). It adds two
plugin extension points: `titleBarRow` on panels, for the row, and
`conversation.registerThreadTabAction`, for Pin thread. That PR isn't merged
yet, so no Buzz release has them.

Until one does, the plugin uses places every Buzz has:

- The pinned tabs sit in the title bar, right of Search. They take at most
  half the window less 16rem, so Search narrows but keeps room, and the rest
  go under **+N**. Marks, the right-click menu and +N work the same.
- **Pin thread** is in a message's **…** and right-click menus. It pins the
  thread the message is in, or the thread it starts. A pinned thread's
  messages show **Unpin thread** there instead.

Once your Buzz has the extension points, the plugin switches to the row and
the thread tab menu by itself. There is nothing to change or reinstall, and
your pins carry over.

## Install

Open the install link. Buzz opens **Settings → Plugins → Add** with this
folder picked from Git:

```sh
open 'buzz://plugin-install?repository=man15h%2Fbuzz-plugins&path=plugins%2Fpinned-threads'
```

It asks for no access. Or install from a clone: **Settings → Plugins → Manage
plugins → Add**, then **Browse** under Add from folder, and pick the clone's
`plugins/pinned-threads/` folder.

## Mockups

Design sheets, in [`mockups/`](mockups/).

![Unread marks, the pinned-tab row, overflow and the right-click menu, light and dark](mockups/pinned-threads-1.png)

![Rename, Pin thread and Unpin thread in the thread tab menu, and the hidden row with no pins](mockups/pinned-threads-2.png)
