# Stock Imports for Shop

Keeps a Cactus shop's stock counts in step with a supplier's stock file. Give it
the web address of a CSV, say how often to look, and every product whose SKU
appears in that file has its stock count refreshed on its own.

Nothing else about a product is touched: not the price, not the name, not the
description. Stock counts only.

## What it does

- **One address, one setting.** A direct link to a CSV your supplier publishes,
  and a schedule from "every hour" to "once a week". The frequency is a setting,
  not a redeploy.
- **A Test button that answers the real question.** Before saving anything, it
  fetches the file and reports how many of its codes actually match products in
  your shop, which of your products it never mentions, and the first few rows as
  the reader sees them. A CSV that parses perfectly but shares no codes with the
  catalogue is the commonest way one of these is set up wrong, and it looks like
  success until somebody notices nothing ever changes.
- **Fetch Latest Stock, on the Products page.** For when the schedule is not
  soon enough. Contributed through shop's `shop.products-toolbar` extension
  point, so it sits beside shop's own buttons rather than on a page of its own.
- **Column names, not column positions.** Matched case-insensitively and
  ignoring spaces, underscores and hyphens, so `FreeStock`, `Free Stock` and
  `free_stock` are the same column and a supplier inserting a column upstream
  does not silently start writing the wrong number.
- **A choice about products the file does not mention.** Leave them alone (the
  default, and the right answer when the file is one supplier's range) or treat
  them as out of stock (right only when it is the whole catalogue).
- **Optional enforcement.** A tickbox switches the shop's own inventory tracking
  on for the products it updates, so the shop actually stops selling something
  once it has run out. Off by default: recording a number and enforcing it are
  different decisions.
- **An audit trail.** Every run, scheduled or by hand, with counts and whatever
  went wrong. Kept to the last fifty.

## How it copes with big files and small time limits

Module routes on Vercel are capped at sixty seconds and the cap cannot be
raised. A first run over a twenty-thousand-product catalogue does not reliably
fit in that, so a run is a resumable job:

1. **Fetch.** Download the file, read it against the shop's SKUs, and work out
   the writes it implies. Only products whose count actually moved are included;
   a file that has not changed produces no writes at all.
2. **Apply.** Write them a thousand at a time, saving progress after every
   batch. If the clock runs low the run stops cleanly with its remaining work
   parked, and the next caller picks it up - the Products button carries on
   automatically, and an unattended run is resumed by the next hourly cron tick.

A lease on the job row stops the button and the cron treading on each other, and
expires by itself so a request that dies mid-run cannot wedge the thing shut.

## Reading the file

Suppliers export these from whatever their warehouse system happens to be, so
the reader copes with a byte-order mark, Windows line endings, quoted fields
containing the delimiter, doubled quotes, and a delimiter that may be a comma,
semicolon, tab or pipe.

Stock figures are read as whole units. `360`, `360.00`, `1,250` and `(5)` are all
understood; decimals round down, never up, and a negative free stock (more
allocated than held) becomes zero, because "how many can be sold" cannot be minus
four. A blank or unreadable cell leaves the product's count alone and is reported
rather than guessed at - writing a guessed stock count is how a shop ends up
refusing orders it could have taken.

## Settings

Admin → Settings → Shop → **Stock**. A sub-tab hosted in shop's own settings tab
through the `shop.settings-sub-tabs` slot; shop lends the space and nothing else.

| Setting | What it does |
| --- | --- |
| Address of the stock file | Direct link to the CSV. `https` or `http`; addresses pointing back at the site itself are refused. |
| Column with the product code | Matched against each product's SKU. Default `ProductCode`. |
| Column with the number in stock | Default `FreeStock`. |
| Check for new figures | Off, or every 1/2/3/4/6/8/12/24/48 hours, or weekly. |
| Products the file does not mention | Leave alone, or treat as out of stock. |
| Actually hold shoppers to these numbers | Switches shop's inventory tracking on for physical products this updates. |
| Username / password | Only if the feed is behind HTTP basic auth. The password is encrypted at rest with `ENCRYPTION_KEY`. |

## Requirements

- The **Shop** module (0.1.61 or newer, for the `shop.products-toolbar` point).
- `CRON_SECRET` set, so the scheduled check can authenticate itself.
- `ENCRYPTION_KEY` set, if the feed needs a username and password.
- A host that allows an hourly cron. On Vercel that means a Pro plan or above -
  Hobby caps cron jobs at once a day, and the module registers an hourly tick so
  that the frequency can be a setting rather than a deployment.

## Permissions

No permission keys of its own. Settings need `shop.manage`; the Products page
button needs `shop.products`.

## Tables

`stk_settings`, `stk_import_job`, `stk_import_log`. All prefixed `stk_`, all
listed in the manifest's `teardown`.

## Routes

| Route | Purpose |
| --- | --- |
| `GET/PUT /api/m/stock-import-for-shop/admin/settings` | Read and save settings |
| `POST /api/m/stock-import-for-shop/admin/test` | Probe a feed and report, changing nothing |
| `POST /api/m/stock-import-for-shop/admin/run` | Start a run |
| `POST /api/m/stock-import-for-shop/admin/run/step` | Apply the next slice of an unfinished run |
| `GET /api/m/stock-import-for-shop/admin/run/status` | Progress, and whether a feed is set up |
| `POST /api/m/stock-import-for-shop/admin/run/cancel` | Stop part-way |
| `GET /api/m/stock-import-for-shop/admin/log` | The last twenty runs |
| `GET /api/m/stock-import-for-shop/cron/import` | Hourly tick; runs only when the owner's schedule says so |

## Licence

MIT.
