# User Guide

- [Part 1 – Participants](#part-1--participants): copy this part into your event's group chat
- [Part 2 – Organisers (admins)](#part-2--organisers-admins)

---

## Part 1 – Participants

### What is this?
You've been given a **Mortal**. That's someone you'll secretly take care of during Angel & Mortal. Someone else is **your Angel**, secretly taking care of you.

This bot lets you chat with **both**. Your Mortal never finds out you're their Angel, and you won't find out who your Angel is (unless you guess 👀).

### Getting started
1. **Use Telegram on your phone, updated to the latest version.** The bot gives you two chat tabs. The phone apps show them; some computer versions of Telegram (Desktop and Web) don't show them reliably yet.
2. **Make sure you have a Telegram username.** Go to Settings → Username. The organisers matched you using it, so don't change it during the event. If you must change it, tell an organiser.
3. Open the bot and tap **Start**.
4. The bot welcomes you, tells you who your Mortal is, and adds **two tabs** to the chat: **😇 Angel: secret (cares for you)** and **🙂 Mortal: @their_username (you care for them)**.

If the bot says you're not on the list, message an organiser with your username.

### Sending messages
The bot chat has two tabs. Each one is a separate conversation:

| Tab | What you type there goes to | What arrives there |
|---|---|---|
| 😇 **Angel: secret (cares for you)** | your Angel, the secret person taking care of **you** | messages from your Angel |
| 🙂 **Mortal: @username (you care for them)** | your Mortal, the person **you** take care of | messages from your Mortal |

The tab name is shown at the top while you chat, so you can always check who you're talking to. If the organisers change the pairings, the Mortal tab is renamed automatically.

Every message you receive starts with a bold label: **😇 Angel:** or **🙂 Mortal (@username):**. Telegram also shows an **All** tab that mixes both chats together, and it can't be turned off. The labels tell you who sent what there, but it's easiest to **chat inside the Angel and Mortal tabs**.

Open a tab and type. The tab you're in is always the person you're talking to, so there's nothing to switch or remember.

Messages typed in the main chat, outside the tabs, are **not** sent. The bot tells you to open a tab instead.

You can send text, photos, videos, GIFs, stickers, voice notes, files and locations.

### Replying to a specific message
Inside a tab, swipe left on a message (or long-press → **Reply**) to reply to it. It appears as a reply on their side too.

### Ticks and warnings
- **No reply from the bot**: your message was delivered. There are no ticks or reactions.
- **A ⚠️ warning replying to your message**: that message was **not** delivered. The warning quotes it, so you know which one to resend.
- **"hasn't started the bot yet"**: the other person hasn't joined, so your message was **not** delivered. Try again later.
- **"Messaging is paused"**: the organisers have paused the bot for now.
- **"⚠️ Not sent. Type inside the 😇 Angel tab or 🙂 Mortal tab"**: you typed outside the tabs, so nothing was sent.
- **No tabs?** Switch to Telegram on your phone, updated to the latest version. If they're still missing there, send `/start` again.

### Good to know
- The **All** tab shows both chats mixed together. Read and reply in the 😇 Angel and 🙂 Mortal tabs instead, so you never answer the wrong person.
- **Editing or deleting** a message after sending does **not** change what the other person already received. Think before you send!
- As an Angel, careful: your **voice** (voice notes), your writing style and personal photos can give you away.
- Your Mortal's name is shown to you. Your Angel's name is never shown to anyone.

### Commands
| Command | |
|---|---|
| `/start` | Join, see your Mortal and get your two tabs |
| `/whoismymortal` | Remind me who my Mortal is |
| `/help` | Show help |

---

## Part 2 – Organisers (admins)

You become an admin when your Telegram ID is in the `ADMIN_IDS` secret. See the [Developer Guide](DEVELOPER_GUIDE.md#deployment). To find your ID, message the bot `/myid`.

### Preparing the pairing list
Use a CSV, or plain text, with **one `angel,mortal` pair per line**, using Telegram usernames:
```
angel,mortal
alice_tan,bob_lim
bob_lim,charlie_ng
charlie_ng,alice_tan
```
- The header row is optional. `@` and capital letters don't matter.
- Blank lines and lines starting with `#` are ignored, so you can add comments.
- Commas, tabs, semicolons or spaces all work as separators. A sheet copied straight from Google Sheets works.
- Each person should appear **exactly once as an angel and once as a mortal**.

> 🔒 Don't put the real list in the GitHub repo, or anywhere participants can see it.

### Uploading
Either:
- send `/upload`, then paste the lines **in the same message**, or
- send the `.csv` file with `/upload` as the **caption**.

The bot checks the list:

| Result | Meaning |
|---|---|
| ❌ **Errors** | **Nothing is saved.** Causes: a line without exactly two usernames, an invalid username (Telegram usernames are 4–32 letters, digits or underscores), someone paired with themselves, someone listed twice as angel or twice as mortal. Fix the list and upload again. |
| ⚠️ **Warnings** | The list **is** saved, but check it. Causes: someone with no angel or no mortal, or two people who are each other's angel *and* mortal, so they can figure each other out. |

Uploading again **replaces** the whole list. People who already joined stay joined, as long as they're still on the new list. Uploaded the wrong list? `/undoupload` puts the previous one back.

### Admin commands
| Command | What it does |
|---|---|
| `/admin` | Shows this list |
| `/upload` | Replaces all pairings (see above) |
| `/pairs` | Lists every Angel → Mortal pair; ⏳ = hasn't joined yet |
| `/status` | Participants, how many joined, messages relayed, broadcasts still queued, paused or running |
| `/missing` | Usernames that haven't started the bot. Use it to chase people. |
| `/broadcast <message>` | Sends "📢 Announcement from the organisers" plus your message to everyone who has joined. About 25 go out immediately and the rest within a minute or two. People who haven't joined yet won't get it. |
| `/pause` / `/resume` | Stop or start all messaging, e.g. before the event starts or during an issue. `/broadcast` still works while paused. |
| `/swap @old @new` | Someone changed or mistyped their username. Fixes it without re-uploading. |
| `/unbind @handle` | The wrong Telegram account joined as `@handle` (e.g. the list had a typo and someone else owns that username). Detaches it so the right person can join. If that account still holds the username, also `/swap` the handle to the person's real username. |
| `/undoupload` | Restores the pairings from before the last `/upload`. Send it again to switch back. People not on the restored list are removed, so they'll have to `/start` again later. |
| `/myid` | Shows your Telegram ID |

### Suggested launch checklist
1. Open the `/setup` link and check it says **✅ Threaded Mode is on**. If not, turn it on in @BotFather first (see the [Developer Guide](DEVELOPER_GUIDE.md#deployment)).
2. `/upload` the pairings and fix any errors or warnings.
3. `/pause`, so nobody chats before the event officially starts.
4. Post **Part 1** of this guide and the bot link in the group chat, and remind everyone to **use the Telegram app on their phone, updated** first. Computer versions don't always show the tabs.
5. Use `/missing` to chase people until everyone has joined.
6. `/resume` when the event starts, and `/broadcast` that it's open 🎉
