# Onix fork maintenance

This fork retains the Onix PostgreSQL image workflow and the custom macOS
MeshCentral Router. Upstream workflows remain disabled. The existing build
workflow is manual; merging this branch does not publish an image.

## Upstream synchronization

The November 2026 update merges upstream `Ylianst/MeshCentral` master at
`b8cac8f2` (343 commits after the previous common ancestor), updating the
package version from 1.1.59 to 1.3.1. This is a master snapshot, including
commits after the 1.3.1 release tag, rather than an unchanged release tarball.
The separate merge commit preserves upstream history and the Onix changes.

Node.js now requires at least 22.21.1. The upstream Alpine image uses Node
24.22.1. Agent binaries now come from pinned GitHub release assets, verified
by size and SHA384, and are cached beneath the configured data directory.
The production environment must be able to reach those release assets, or
all pinned defaults must be included in the image for offline operation.
See `agents/agent-defaults.json`, `agents/check-releases.js`, and `agentbuilds.js`.
Do not remove the persistent data directory when changing images.

Validate the source change:

```sh
node --check agents/meshcore.js
node --test tests/file-operation-errors.test.js
```

Build the same PostgreSQL variant as the manual workflow (Docker is required):

```sh
docker build -f docker/Dockerfile --platform linux/amd64 \
  --build-arg DISABLE_EXTRACT=yes \
  --build-arg DISABLE_MINIFY=yes \
  --build-arg DISABLE_TRANSLATE=yes \
  --build-arg INCLUDE_MONGODB_TOOLS=false \
  --build-arg INCLUDE_POSTGRESQL_TOOLS=true \
  --build-arg INCLUDE_MARIADB_TOOLS=false \
  -t meshcentral-onix-review:local .
```

Before rollout, back up the database and persistent data, validate the configured
PostgreSQL connection, agent downloads, login/SSO and plugins in staging, and
check Windows, Linux and macOS agent connectivity. Review upstream changes to
authentication, database handling and agents. Use the deployment repository's
normal approval and image-pinning process. Do not publish mutable image tags
as a substitute for an approved rollout. The deployment repository image scan
checks for new tags every minute: dispatching the publishing workflow can itself
lead to a production rollout and requires deployment approval.

The manual Docker workflow currently uses a GitHub-hosted Linux runner because
this repository is public and the organization's shared runner groups are
restricted to private repositories. Keep public/untrusted code off those shared
hosts; change runner routing only after a suitably isolated eligible group is
available.

## Visible file failures and recovery

Authenticated classic desktop, alternate desktop and mobile file browsers show
failed deletes and uploads with the affected path and the agent's error text.
Recursive delete failures identify the blocked child file. Failed multi-item
deletes still attempt the remaining selected items; they can partially succeed.
Upload write failures include the active request ID so they do not leave a
progress dialog waiting indefinitely. Legacy upload errors without an ID are
also displayed. File paths and error messages are HTML-escaped.

A user with existing **Agent Console** permission can choose **Restart agent
service** from the error dialog. A second dialog identifies the device and warns
that all its remote sessions will disconnect. Confirmation sends the same
`service restart` command as **Console > Agent Action > Restart agent service**.
It does not add permissions, close individual native handles, terminate unrelated
applications, or retry a deletion/upload automatically. Agent-owned locks should
be released when the service exits; another application's locks require closing
that application. The initial error can also mean insufficient permission or
free disk space; the dialog does not claim that every failure is a file lock.

The agent-side change reports failures; it does not claim to repair the underlying
suspected native ZIP reader/writer handle leak. A server upgrade may refresh the JavaScript
core on connected agents. Confirm that the new core is loaded before expecting
new delete errors from an existing agent. Old upload-error packets remain
supported. Guest sharing layouts are unchanged.

Verification in a disposable Windows test device:

1. Hold a test file open with no sharing. Attempt to delete it and overwrite it
   from Files. Each operation must show the path and an error.
2. Repeat for a locked child in a directory and a multi-selection containing an
   unlocked file; confirm the unlocked item is deleted and the locked path is shown.
3. Use an account without Agent Console rights; confirm no restart action appears.
4. With Agent Console rights, cancel the restart confirmation and verify the agent
   remains connected. Approve only on the disposable device; confirm reconnection
   and retry the file operation after the agent-owned lock is released.

Rollback the custom behavior by reverting its commit. Roll back the upstream
merge using `git revert -m 1 <merge-commit>` on a new branch and review it through
a PR. Runtime rollback uses the previously approved image and, if a data format
changed, the matching pre-upgrade database/data backup. Verify compatibility in
staging before using the old image against upgraded data.
