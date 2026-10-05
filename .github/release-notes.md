Chrome extension build, for testing.

**Install**

1. Download `mfp-flow-extension.zip` below and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped `mfp-flow-extension` folder.
4. Open a MyFundedPerps trade page and click the **mfp·flow** button, bottom right.

Chrome will say the extension is unpacked / in developer mode. That is expected: this is
not published to the Chrome Web Store.

**The chart needs no account and no key.** It reads MyFundedPerps' public market-data
stream. A key is only needed for the account overlay (your entry, stop, target,
liquidation and the two breach lines).

If you want that: the extension's options page takes a **Read Only** API key. A
`fp_test_…` key reaches sandbox accounts only, which is the one to use for testing. The
key is stored in your browser's extension storage, never synced, never sent to the page or
the panel, and never leaves your machine other than to MyFundedPerps' own API.

**This extension is read-only.** There is no order placement, modification or
cancellation code in it; the release build is checked for that automatically.

Markers describe auction structure. They are context, not trade signals, and nothing here
claims an edge.
