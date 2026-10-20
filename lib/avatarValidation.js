// Avatar validation and normalization from Rec-Room-Patches
// Ensures avatar data is safe and properly formatted for 2017 clients

const AVATAR_BODY_PARTS = ["0", "1", "2", "3", "4"];
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_SAFE_AVATAR = {
  OutfitSelections: "ecc1dbe6-ca06-4564-b2a6-30956194d1e9,dee70c38-7a99-4c2b-9181-665f1bf75aca,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,,2;b33dbeee-5bdd-443d-aa6a-761248054e08,,,,1;6d48c545-22bb-46c1-a29d-0a38af387143,,,,2;6d48c545-22bb-46c1-a29d-0a38af387143,,,,3;d0a9262f-5504-46a7-bb10-7507503db58e,,,,1;193a3bf9-abc0-4d78-8d63-92046908b1c5,,,,0",
  HairColor: "f9a50d3d-a6e0-42a4-a4e3-42dc89f84a2e",
  SkinColor: "85343b16-d58a-4091-96d8-083a81fb03ae",
  FaceFeatures: "{\"ver\":3,\"eyeId\":\"AjGMoJhEcEehacRZjUMuDg\",\"eyePos\":{\"x\":0.0,\"y\":0.0},\"eyeScl\":0.0,\"mouthId\":\"FrZBRanXEEK29yKJ4jiMjg\",\"mouthPos\":{\"x\":0.0,\"y\":0.0},\"mouthScl\":0.0,\"beardColorId\":\"befcc00a-a2e6-48e4-864c-593d57bbbb5b\"}"
};

function isGuid(value) {
  return GUID_RE.test((value || '').trim());
}

function cleanGuid(value, defaultValue = "") {
  const text = String(value || "").trim();
  return isGuid(text) ? text : defaultValue;
}

function normalizeOutfitSelections(value) {
  const normalized = [];
  const seen = new Set();

  const rawSelections = String(value || "").split(";");

  for (const rawSelection of rawSelections) {
    const parts = rawSelection.split(",").map(p => p.trim());

    if (parts.length !== 5) continue;

    const [outfit, swatch, mask, decal, bodyPart] = parts;

    if (!isGuid(outfit) || !AVATAR_BODY_PARTS.includes(bodyPart)) continue;
    if (swatch && !isGuid(swatch)) continue;
    if (mask && !isGuid(mask)) continue;
    if (decal && !isGuid(decal)) continue;

    const selection = [outfit, swatch, mask, decal, bodyPart].join(",");

    if (!seen.has(selection)) {
      normalized.push(selection);
      seen.add(selection);
    }
  }

  return normalized.join(";");
}

function normalizeAvatarPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    payload = {};
  }

  const outfitSelections = normalizeOutfitSelections(payload.OutfitSelections || payload.outfitSelections);

  return {
    OutfitSelections: outfitSelections || DEFAULT_SAFE_AVATAR.OutfitSelections,
    HairColor: cleanGuid(payload.HairColor || payload.hairColor, DEFAULT_SAFE_AVATAR.HairColor),
    SkinColor: cleanGuid(payload.SkinColor || payload.skinColor, DEFAULT_SAFE_AVATAR.SkinColor),
    FaceFeatures: payload.FaceFeatures || payload.faceFeatures || DEFAULT_SAFE_AVATAR.FaceFeatures
  };
}

function validateAvatar(avatarData) {
  const errors = [];

  if (!avatarData.OutfitSelections) {
    errors.push("Missing OutfitSelections");
  }

  if (!avatarData.HairColor || !isGuid(avatarData.HairColor)) {
    errors.push("Invalid or missing HairColor GUID");
  }

  if (!avatarData.SkinColor || !isGuid(avatarData.SkinColor)) {
    errors.push("Invalid or missing SkinColor GUID");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  normalizeAvatarPayload,
  validateAvatar,
  DEFAULT_SAFE_AVATAR,
  isGuid,
  cleanGuid
};
