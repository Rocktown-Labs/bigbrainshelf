# Agent access to this repository

Repository: https://github.com/Rocktown-Labs/bigbrainshelf

This repository is private. Putting code and records in GitHub makes them
available to any agent CG authorizes, but GitHub access is always tied to
an identity, a vendor GitHub App, or a machine key. There is no safe
anonymous or shared-login route.

## Access models

| Who is connecting | Grant | Recommended permission |
| --- | --- | --- |
| An agent with its own GitHub account | Add the account as a repository collaborator, or add it to a Rocktown Labs team that has this repository | Write, so it can push branches and open pull requests |
| An online coding agent such as a vendor assistant | Install that vendor's GitHub App and select only `bigbrainshelf` | The vendor's normal repository permission set, limited to this repository |
| An agent running on a trusted machine | Create a separate SSH key for that agent and machine, then add it as a repository deploy key | Read-only for review; enable write access only when that agent must push branches |
| A reviewer or auditor | Add the account as a repository collaborator | Read or Triage, depending on whether it needs to manage issues |

Use one identity or key per agent. That keeps work attributable and lets
CG revoke one agent without breaking the others. Never share RGM's VM
private key, CG's personal GitHub credentials, or a broad personal access
token.

## Owner steps

### GitHub account

1. Open the repository on GitHub.
2. Go to Settings, then Collaborators and teams.
3. Add the person, agent account, or team.
4. Choose Write for development work, or Read for review-only work.

An organization owner may also need to approve an outside collaborator
invitation.

### Vendor GitHub App

1. Start the vendor agent's GitHub connection flow.
2. Install its GitHub App on the Rocktown Labs organization.
3. Under repository access, choose Only select repositories.
4. Select `bigbrainshelf` only.
5. Return to the agent and ask it to verify it can read `AGENTS.md` from
   the repository before assigning work.

### Trusted local machine

1. Generate a new SSH key on that machine for that agent. Do not copy a
   key from another machine.
2. Open the repository on GitHub.
3. Go to Settings, then Deploy keys, then Add deploy key.
4. Name it for the agent and machine, paste the public key, and enable
   Allow write access only if the agent must push branches.
5. Clone with SSH:

```bash
git clone git@github.com:Rocktown-Labs/bigbrainshelf.git
```

## What repository access does not include

A repository grant covers source code, documentation, and committed
records in this repository. It does not provide Cloudflare, Stripe,
Shippo, R2, D1, email, customer, order, or other production access. Those
systems stay separately credentialed and are never accessed from a secret
stored in this repository.

## Onboarding message for a new agent

Copy this into the agent's first task:

```text
Work in the private GitHub repository Rocktown-Labs/bigbrainshelf.
Before editing, read AGENTS.md, README.md, docs/agent-access.md, and the
nearest nested AGENTS.md for the area you will touch. Pull the latest
main, create a branch named agent/<your-name>/<short-task>, and open a
pull request when the work is ready. The shared factory source is in
factory/. The audit tools and evidence are in factory-ops/. Do not push
directly to main, commit secrets or generated output, deploy, publish,
spend, or access production systems unless CG explicitly authorizes that
action in the task.
```

## Revoking access

- Collaborator or team: repository Settings, then Collaborators and
  teams, then remove the account or change the team's repository access.
- Vendor app: organization Settings, then GitHub Apps, then remove this
  repository from the app or uninstall the app.
- Machine: repository Settings, then Deploy keys, then delete that
  agent's key.
