# Deployment Plan

_Working deployment strategy. This documents where the eval should run and how
fresh benchmark runs should be created. It is not current implementation status._

## Direction

Prioritize KubeVirt as the long-term deployment target.

The benchmark wants repeatable, isolated, full-authority environments: one VM per
run, fresh model memory, fresh world state, stable prompt/version inputs, and an
off-VM measurement record. KubeVirt is more machinery than a single local VM, but
it gives us useful run orchestration primitives early: declarative VM specs,
PVC-backed disks, cloneable golden images, labels, Services, and a path to parallel
model runs.

Plain libvirt is still a viable fallback and can support the same image layout,
but the preferred project direction is KubeVirt-first.

## Authority Boundary

Inside the VM, the admin should eventually be sovereign:

- Run as root or with effectively root-equivalent authority.
- Inspect and modify the server, plugins, configs, reducer prompts, local state,
  scripts, and harness support systems.
- Install packages, download mods/plugins, write tools, change rate limits, edit
  prompts, break the world, or break local support systems.

Outside the VM, the runner retains control of the measurement boundary:

- Off-VM exfil collector/storage.
- VM lifecycle: create, snapshot, stop, destroy.
- API/billing controls and secrets rotation.
- Public network exposure.
- Emergency stop.

This is not meant to box in the model's server authority. It preserves the
measurement apparatus.

## Target VM Layout

Inside each eval VM:

```text
/opt/minecraft-eval/
  app/             harness code or release bundle
  server/          Paper server and plugins
  state/           model-owned memory and editable reducer prompts
  logs/            local operational logs
  exfil-spool/     local outgoing exfil retry buffer
```

System services:

```text
minecraft.service
minecraft-eval.service
exfil-forwarder.service
```

The admin process should eventually use the Pi coding-agent tool surface plus
Minecraft-specific tools:

```text
Minecraft: rcon, say, tell
Pi coding: read, write, edit, bash, grep, find, ls
```

Use an explicit tool profile so local development can remain constrained while VM
runs get the full authority surface:

```text
ADMIN_TOOL_PROFILE=limited | pi-readonly | pi-full
```

Intended defaults:

- `limited`: current shakedown profile, RCON plus scoped state file tools.
- `pi-readonly`: read/search/list tools plus Minecraft tools.
- `pi-full`: full Pi coding tools plus Minecraft tools. Intended for isolated VMs.

## Phase 0: Host Readiness

Goal: prove this machine can run KubeVirt VMs with hardware acceleration.

Checklist:

- Fix `kubectl` access to the local k3s cluster.
- Confirm the node exposes `/dev/kvm`.
- Install or verify KubeVirt.
- Boot a tiny test VM.
- Confirm console or SSH access.
- Confirm a Kubernetes Service can expose a VM port.

Deliverable:

```text
kubectl get vmis
test VM reachable
```

## Phase 1: Minimal Eval VM

Goal: one VM that can run the current harness and Paper server.

Inside VM:

- Linux base image.
- Java.
- Node.
- Repo checkout or release bundle.
- Paper server.
- `.env` or injected run config.
- `minecraft.service`.
- `minecraft-eval.service`.

KubeVirt resources:

- `VirtualMachine`.
- PVC for root disk.
- Service for Minecraft `25565`.
- Optional Service or console path for SSH/admin access.

Deliverable:

```text
player can join server
harness can connect RCON
operator message -> admin action works
```

## Phase 2: Off-VM Exfil

Goal: make the measurement record survive the admin nuking the VM.

Preferred pattern:

```text
VM harness/exfil-forwarder
  -> HTTP append API
  -> exfil collector outside admin VM
  -> append-only-ish storage
```

Avoid relying on a writable shared mount as the only record. If the VM can write
and delete it directly, the model can erase it.

The VM may keep a local spool for retry, but the authoritative record lives
outside VM authority.

Deliverable:

```text
admin VM deletes local files
collector still has ground_truth/model_experience/model_internals
```

## Phase 3: Pi Full Toolbelt Admin

Goal: give the admin the agency intended by the benchmark.

Wire the main admin agent to use:

- `rcon`, `say`, `tell`.
- Pi coding-agent built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`.

Run with:

```text
ADMIN_TOOL_PROFILE=pi-full
```

inside the isolated VM.

Deliverable:

```text
admin can inspect files, edit reducer prompts, install packages/mods, write scripts,
and operate the server from inside the VM
```

## Phase 4: Durable Ingestion

Goal: make reducer perception replayable and crash-resumable.

Target architecture:

```text
LogIngestor
  latest.log -> parse -> seq -> ground_truth/exfil

ReducerWorkers
  consume seq ranges -> complete() -> heartbeat/error
```

Features:

- Monotonic sequence IDs.
- Log rotation reopen.
- Reducer retry/backoff.
- Degraded heartbeat on failure.
- Replay from last reduced sequence.

Deliverable:

```text
restart harness/VM and reducers resume without losing raw events
```

## Phase 5: Golden Image

Goal: fresh eval runs are cheap and reproducible.

Build a golden image with:

- Pinned OS base.
- Java.
- Node.
- Harness release or checkout.
- Paper bootstrap.
- Systemd units.
- Exfil client/forwarder.
- First-boot setup script.

Do not bake run memory into the image.

Per run:

```text
clone PVC from golden image
inject run config via cloud-init/secret
start VM
register exfil run
expose Minecraft Service
reset model memory
```

Key reproducibility inputs:

- Golden image version.
- Harness git commit.
- Prompt versions.
- Model/provider config.
- World seed or world snapshot.
- Admin prompt disclosure variant.
- Tool profile.
- Exfil destination.
- Run ID.

Deliverable:

```text
make run MODEL=... WORLD_SEED=...
# creates fresh VM and starts benchmark
```

## Phase 6: Private Multiplayer Shakedown

Goal: test social/load behavior before public.

Add:

- Consent/MOTD.
- Chat rate limits + optional chat-relay debounce.
- Synthesis tick.
- Basic world snapshots.
- Operational dashboard.

Deliverable:

```text
friends can join, interact in chat with the admin, and produce useful eval traces
```

## Phase 7: Public Run

Goal: real benchmark run.

Requirements:

- Fresh VM from golden image.
- Model memory reset.
- Off-VM exfil verified.
- Cost caps.
- Snapshot/reset controls.
- Consent page/MOTD.
- Public network hardening.
- Operator emergency stop outside VM.

Deliverable:

```text
public server administered by model with full authority inside the VM
```
