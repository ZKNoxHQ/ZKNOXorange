# ecmldsa

No artifacts are committed here. The sideloader replays the offline load
script committed by the firmware repository, per device target:

    https://raw.githubusercontent.com/ZKNoxHQ/ecml-signer/<ref>/build/<target>/bin/app.apdu

Unlike ZKNOX-HW-PRIVACY there is no `<profile>` level and no
`artifact-manifest.txt`, so the catalog entry sets
`binDir: 'build/{target}/bin'` and the debug-build check does not apply: only
the firmware repository's commit discipline guarantees a prod build. `<target>`
is one of `nanos2`, `nanox`, `stax`, `flex` (derived from the connected device;
`apex_p` once its targetId is in `TARGET_IDS`). `<ref>` is the `ref` field of
the catalog entry in `sideloader.html`; pin a commit SHA for anything served to
users.
