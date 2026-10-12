# privacy

No artifacts are committed here. The sideloader replays the offline load
script committed by the firmware repository, per device target:

    https://raw.githubusercontent.com/ZKNoxHQ/ZKNOX-HW-PRIVACY/<ref>/build/<target>/bin/app.apdu

`<target>` is one of `nanos2`, `nanox`, `stax`, `flex` (derived from the
connected device; `apex_p` once its targetId is in `TARGET_IDS`). `<ref>` is
the `ref` field of the catalog entry in `sideloader.html`; pin a commit SHA
for anything served to users.
