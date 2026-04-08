# Product Hunt Launch

## Tagline

The terminal workspace for agentic development

## Description (500 char limit)

A terminal workspace for running AI coding agents in parallel. A persistent sidebar shows every agent session at a glance. Green dot means new output, orange flag means it finished and needs your review. One click to switch. Works with Claude Code, Codex, aider, or anything else. Built on tmux, runs anywhere: local, SSH, containers. Bring your own editor, your own tools, your own workflow. Nothing proprietary, nothing locked in.

## First Comment

Hey Product Hunt! I built jmux because plain tmux stopped scaling for me.

I was running 5 to 10 Claude Code instances at once, each on its own feature branch. tmux handled the sessions fine, but *I* couldn't keep up. Which tab had the agent that just finished? Which one was stuck waiting for input? I'd cycle through all of them, one by one, trying to remember where I left off. The more agents I ran, the worse it got. The productivity gains from parallelism were getting eaten by the overhead of managing it.

I tried customizing tmux's status bar. I wrote shell scripts. I set up notifications. None of it stuck. The core problem was that tmux treats every session the same. There's no concept of "this one needs your attention" versus "this one is still working." That distinction matters when you're running agents, because unlike a human typing in a shell, an agent has a clear lifecycle: working, waiting for input, or done.

So I built jmux. It wraps tmux and adds a sidebar that shows every session with real-time status. When an agent finishes, an orange flag appears instantly. You click it, review the work, and move on to the next one. No more cycling through tabs. No more guessing.

A few things that make the workflow click:

- **Agent hooks.** One command (`jmux --install-agent-hooks`) and Claude Code automatically flags its session the moment it finishes. Any agent that can run a shell command on exit can do the same.
- **Worktree integration.** Each agent gets its own isolated copy of the repo via git worktrees. No stashing, no merge conflicts, no branch switching. Spin up 5 worktrees from main, start an agent in each, and let them all work in parallel.
- **Zero lock-in.** jmux orchestrates tmux sessions. If you stop using it, your sessions are still there. Your tools, your config, your plugins all carry over.
- **Runs anywhere.** Local, SSH, containers, devboxes. No Electron, no cloud, no GUI. Just your terminal.

It's about 2,400 lines of TypeScript, runs on Bun, and installs with `bun install -g @jx0/jmux`.

I'd love to hear from anyone else juggling multiple agents. What does your setup look like? What's the messiest part of your workflow?

## Tags

- Developer Tools
- Software Engineering
- Open Source (or AI, if Open Source isn't available)
