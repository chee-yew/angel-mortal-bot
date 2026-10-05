# User Guide

- [Part 1 – Participants](#part-1--participants): copy this part into your event's group chat
- [Part 2 – Organisers (admins)](#part-2--organisers-admins)

---

## Part 1 – Participants

### What is this?
You've been given a **Mortal**. That's someone you'll secretly take care of during Angel & Mortal. Someone else is **your Angel**, secretly taking care of you.

This bot lets you chat with **both**. Your Mortal never finds out you're their Angel, and you won't find out who your Angel is (unless you guess 👀).

### Getting started
1. **Make sure you have a Telegram username.** Go to Settings → Username. The organisers matched you using it, so don't change it during the event. If you must change it, tell an organiser.
2. Open the bot and tap **Start**.
3. The bot welcomes you and tells you who your Mortal is.

If the bot says you're not on the list, message an organiser with your username.

### Sending messages
At the bottom of the chat there are buttons:

| Button | What it does |
|---|---|
| 🙂 **Chat with Mortal** | Everything you send goes to your Mortal. They see it as "😇 From your Angel". |
| 😇 **Chat with Angel** | Everything you send goes to your Angel. They see it as "🙂 From your Mortal". |
| ❓ **Help** | Shows the help message |

Tap a button once. Everything you send after that goes to that person **until you tap the other button**. Check which mode you're in before sending something secret! 😉

You can send text, photos, videos, GIFs, stickers, voice notes, files and locations.

### Replying to a specific message
Swipe left on a message (or long-press → **Reply**) to reply to it. Your reply goes back to **whoever sent that message**, even if you're in the other mode, and it appears as a reply on their side too.

### Ticks and warnings
- **👍 on your message**: it was delivered.
- **"hasn't started the bot yet"**: the other person hasn't joined, so your message was **not** delivered. Try again later.
- **"Messaging is paused"**: the organisers have paused the bot for now.

### Good to know
- **Editing or deleting** a message after sending does **not** change what the other person already received. Think before you send!
- As an Angel, careful: your **voice** (voice notes), your writing style and personal photos can give you away.
- Your Mortal's name is shown to you. Your Angel's name is never shown to anyone.

### Commands
| Command | |
|---|---|
| `/start` | Join and see your Mortal |
| `/mortal` | Switch to messaging your Mortal |
| `/angel` | Switch to messaging your Angel |
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

Uploading again **replaces** the whole list. People who already joined stay joined, as long as they're still on the new list.

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
| `/myid` | Shows your Telegram ID |

### Suggested launch checklist
1. `/upload` the pairings and fix any errors or warnings.
2. `/pause`, so nobody chats before the event officially starts.
3. Post **Part 1** of this guide and the bot link in the group chat.
4. Use `/missing` to chase people until everyone has joined.
5. `/resume` when the event starts, and `/broadcast` that it's open 🎉
