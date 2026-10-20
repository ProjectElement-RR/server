Content data files for the 2017 API.

These were seeded from the reference servers because this repo shipped with no
game content of its own - without them, equipment/avatar-item/storefront
endpoints return empty lists and the client shows nothing.

Source:
  OpenRec  -> net6.0/Download/   (equipment, avataritems, avataritems2,
                                  baserooms, consumables, configv2,
                                  storefront2, gameconfigs)
  Rec.js   -> user-info/         (charades.txt)

Files are served verbatim by the matching route (see routes/equipment.js).
If a file is missing or empty the endpoint falls back to [] rather than 500ing,
so deleting any of these is safe.
