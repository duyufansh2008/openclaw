#!/bin/bash
set -euo pipefail
task_root=/root/pr148193-proof
if [[ -f "$task_root/namespace-target" ]]; then
  proof_pid=$(<"$task_root/namespace-target")
  if [[ -d "/proc/$proof_pid" ]]; then
    exec nsenter --target "$proof_pid" --mount --pid --user --uts --ipc --root --wd /usr/bin/env -i HOME=/home/proof PATH=/proof/bin:/usr/bin:/bin LANG=C.UTF-8 XDG_CACHE_HOME=/home/proof/.cache NO_PROXY=127.0.0.1,::1 "$@"
  fi
fi
args=(--clearenv --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --symlink usr/bin /bin --symlink usr/sbin /sbin --proc /proc --dev /dev --ro-bind /etc/resolv.conf /etc/resolv.conf --ro-bind /etc/ssl /etc/ssl --ro-bind /etc/hosts /etc/hosts --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf --ro-bind "$task_root/runtime/etc/passwd" /etc/passwd --ro-bind "$task_root/runtime/etc/group" /etc/group --bind "$task_root/runtime" /proof --bind "$task_root/runtime/home" /home/proof --bind "$task_root/runtime/tmp" /tmp --bind "$task_root/evidence" /evidence --bind "$task_root/artifacts" /artifacts --unshare-user --unshare-pid --unshare-ipc --unshare-uts --hostname pr148193-linux-proof --ro-bind /sys/fs/cgroup /sys/fs/cgroup --setenv HOME /home/proof --setenv PATH /proof/bin:/usr/bin:/bin --setenv LANG C.UTF-8 --setenv XDG_CACHE_HOME /home/proof/.cache --setenv NO_PROXY 127.0.0.1,::1)
if [[ -d "$task_root/source" ]]; then args+=(--bind "$task_root/source" /source --chdir /source); fi
exec bwrap "${args[@]}" "$@"
