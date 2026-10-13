# privacy

No artifacts are committed here. The sideloader replays the offline load
script committed by the firmware repository, per profile and device target:

    https://raw.githubusercontent.com/ZKNoxHQ/ZKNOX-HW-PRIVACY/<ref>/build/<profile>/<target>/app.apdu

`<profile>` is `prod` (MODE=prod FROST=0) or `dev` (MODE=debug FROST=1, key
extraction instructions compiled in: test devices only). `<target>` is one of
`nanos2`, `nanox`, `stax`, `flex` (derived from the connected device; `apex_p`
once its targetId is in `TARGET_IDS`). `<ref>` is the `ref` field of the
catalog entry in `sideloader.html`; pin a commit SHA for anything served to
users. The `artifact-manifest.txt` beside the script is checked: a debug build
is refused unless the entry says `profile: 'dev'`.
