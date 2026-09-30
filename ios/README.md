# Scan2Print Scanner (native iPad / iPhone app)

A small native companion to the [Scan2Print web editor](https://mxrlow1.github.io/scan2print/). It uses the
**LiDAR scanner** (ARKit scene reconstruction) to capture a 3D mesh, then lets you:

- set a **crop target** on the object (a translucent sphere) so the rest of the room is thrown away,
- **remove the floor/table** it detected under the object,
- **keep only the largest piece**, weld the ARKit chunks together and centre the model on the build plate,
- save as **STL** (millimetres, Z up, ready for slicers), **OBJ** or **PLY** (mm, Y up),
- share it (AirDrop, Save to Files, …) and open the web editor to fill holes, cut, smooth, resize and export a watertight STL/3MF.

> **Hardware:** LiDAR mesh scanning needs an **iPad Pro (2020 or later)** or an **iPhone 12 Pro or later Pro model**,
> running iPadOS/iOS **17+**. On other iPads the app opens but the scan button is disabled (use a photo-scan app such as
> Scaniverse / Polycam / KIRI Engine and open the export in the web editor instead).
> ARKit only runs on a real device, not in a simulator, and not in the Swift Playgrounds preview pane. Use **Run** (full screen).

There are two ways to get it onto your iPad, and **neither needs a Mac**.

---

## Path 1: Swift Playgrounds on the iPad (free, no developer account)

1. Install **Swift Playgrounds** (free, by Apple) from the App Store on the iPad. You need version 4.4 or later.
2. On the iPad, open Safari and go to <https://github.com/mxrlow1/scan2print>. Tap **Code → Download ZIP**.
3. Open the **Files** app → **Downloads**, then tap `scan2print-main.zip` to unzip it.
4. Open `scan2print-main` → `ios` and tap **`Scan2PrintScanner.swiftpm`**. It opens in Swift Playgrounds.
   (If it doesn't, open Swift Playgrounds, tap the folder icon or **Locations**, and browse to that file.)
   Tip: move the `.swiftpm` into *On My iPad → Swift Playgrounds* first so it shows up in the app's library.
5. Tap **▶︎ Run** (or the app-preview button, then run full screen). When asked, **allow camera access**.
6. Scan: walk slowly around the object, aim the **+** at it and tap **Set target**, adjust the crop size, then tap **Finish**.
   On the result screen, choose the clean-up options and a format, tap **Save**, then **Share / Save to Files**.

Notes
- In Swift Playgrounds the app's own Documents folder isn't visible in Files, so always use **Share / Save to Files**.
- The app stays inside Swift Playgrounds. If you later get a paid developer account, Swift Playgrounds itself can upload
  it to App Store Connect / TestFlight (**App Settings → Upload to App Store Connect**). Path 2 does the same thing automatically.
- A pre-zipped `Scan2PrintScanner.swiftpm.zip` is also attached to every run of the **iOS app** GitHub Action
  (Actions tab → latest run → *Artifacts*). You have to be signed in to GitHub to download it.

---

## Path 2: TestFlight build made by GitHub Actions (needs the $99/year Apple Developer Program)

The workflow [`.github/workflows/ios.yml`](../.github/workflows/ios.yml) runs on a GitHub-hosted **macOS** machine:

| Secrets configured? | What the workflow does |
|---|---|
| No (default) | Runs the MeshCore unit tests, generates an Xcode project with XcodeGen, does an **unsigned build check** for iOS, and uploads artifacts (`Scan2PrintScanner-unsigned.ipa` and the zipped `.swiftpm`). It passes and prints a notice saying signing is off. The unsigned `.ipa` can't be installed as-is. It only proves the app compiles. |
| Yes | Everything above, plus a **signed archive** using cloud-managed automatic signing with your App Store Connect API key, export of an App Store `.ipa`, and **upload to TestFlight**. The build number is the workflow run number. |

### One-time setup (all in Safari on the iPad)

1. **Join the Apple Developer Program** at <https://developer.apple.com/programs/enroll/> ($99/year). Approval can take a day or two.
2. **Note your Team ID**: <https://developer.apple.com/account> → *Membership details* → **Team ID** (10 characters).
3. **Register the bundle ID**: <https://developer.apple.com/account/resources/identifiers/list> → **+** → *App IDs* → *App*.
   Choose explicit, `io.github.mxrlow1.scan2print.scanner`, no extra capabilities → Register.
   (To use a different ID, set it here and add a repository **variable** `IOS_BUNDLE_ID` with the same value.)
4. **Create the app record**: <https://appstoreconnect.apple.com/apps> → **+** → *New App*. Platform iOS, name e.g. "Scan2Print Scanner"
   (App Store names must be unique, so add something if it's taken), pick the bundle ID from step 3, and any SKU (e.g. `scan2print-scanner`).
5. **Create an API key**: App Store Connect → *Users and Access* → **Integrations** → *App Store Connect API* → *Team Keys* → **+**.
   Give it the **Admin** access role (cloud-managed signing needs Admin to create certificates and profiles).
   **Download the `.p8` file** (you can only download it once) and note the **Key ID** and the **Issuer ID** shown above the list.
6. **Add GitHub secrets**: <https://github.com/mxrlow1/scan2print/settings/secrets/actions> → *New repository secret*:

   | Secret | Value |
   |---|---|
   | `ASC_KEY_ID` | Key ID from step 5 (e.g. `ABC123DEFG`) |
   | `ASC_ISSUER_ID` | Issuer ID from step 5 (a UUID) |
   | `ASC_KEY_P8` | The full text of `AuthKey_XXXX.p8`, including the `-----BEGIN PRIVATE KEY-----` lines. On the iPad, open the file in Files with a text editor such as Runestone or Textastic (or use Quick Look → Share → Copy), then paste it. Base64 of the file also works. |
   | `APPLE_TEAM_ID` | Team ID from step 2 |

### Each build

1. GitHub → **Actions** → **iOS app (build check / TestFlight)** → **Run workflow** (it also runs automatically when anything under `ios/` changes on `main`).
2. Wait about 10–20 minutes. Then App Store Connect → your app → **TestFlight**. The build shows *Processing* for 5–30 minutes.
   The first time, answer the export-compliance question if asked (the app sets `ITSAppUsesNonExemptEncryption = NO`, so usually it isn't).
3. In TestFlight → *Internal Testing* → create a group and add yourself (your Apple ID must be a user of the App Store Connect team).
4. Install the **TestFlight** app on the iPad, accept the invite, and tap **Install**. TestFlight builds expire after 90 days, so rerun the workflow to refresh.

### Troubleshooting

- *"No profiles for … were found" / "Cloud signing permission error"*: the API key needs the **Admin** role, and the bundle ID must be registered to the same team as `APPLE_TEAM_ID`.
- *"No suitable application records were found"*: the App Store Connect app record (step 4) is missing or uses a different bundle ID.
- *"The bundle version must be higher"*: builds are numbered by the workflow run number, so just run it again.
- Automatic signing on CI may create a new Apple Distribution certificate on some runs. Apple allows a few per team,
  so revoke old ones at developer.apple.com → *Certificates* if you hit the limit.

---

## Project layout

```
ios/
├── Scan2PrintScanner.swiftpm/     Swift Playgrounds app package (also opens in Xcode 15+)
│   ├── Package.swift              .iOSApplication product, bundle ID, camera permission, icon
│   └── Sources/
│       ├── Scan2PrintScannerApp.swift   app entry + editor link
│       ├── ContentView.swift            home: LiDAR check, saved scans, tips
│       ├── ScanSession.swift            ARKit session, crop target, floor detection, ARMeshAnchor → mesh
│       ├── ScanViews.swift              scan screen + result/clean-up/save screen
│       ├── MeshPreview.swift            SceneKit 3D preview
│       ├── ScanLibrary.swift            Documents/Scans storage
│       ├── MeshCore.swift               pure-Swift mesh ops + STL/OBJ/PLY writers (unit-tested)
│       └── Assets.xcassets              app icon
├── Tests/MeshCoreTests/main.swift  MeshCore tests (run on Linux or macOS with plain swiftc)
└── project.yml                     XcodeGen spec (same Sources) used by CI to build, sign and upload
```

Run the mesh tests anywhere Swift is installed (Linux works too):

```sh
swiftc -O ios/Scan2PrintScanner.swiftpm/Sources/MeshCore.swift ios/Tests/MeshCoreTests/main.swift -o /tmp/meshcore-tests && /tmp/meshcore-tests
```

## Limitations

- LiDAR meshes are coarse (about 1–2 cm detail). Good for furniture-sized or fist-sized objects, not for small detailed ones.
  For small objects use a photogrammetry app (e.g. Scaniverse, Polycam, KIRI Engine, or Apple Object Capture apps) and the web editor.
- The mesh has no colour/texture. It's geometry only, which is all a printer needs.
- Scans are usually not watertight straight from the scanner. Finish them in the web editor (fill holes / close bottom) before slicing.
