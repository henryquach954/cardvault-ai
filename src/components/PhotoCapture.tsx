/**
 * Front/back photo capture.
 *
 * On iPhone, `capture="environment"` opens the rear camera directly from the
 * file input, so there is no custom camera UI to maintain and no permissions
 * dance -- the OS picker handles both "take photo" and "choose existing".
 *
 * Photos upload immediately to their FINAL storage path, which is possible
 * because the inventory item's UUID is generated before the row is inserted.
 * The alternative (upload on save) makes the operator wait at the moment they
 * least want to, after a long form.
 *
 * These are the operator's own photographs. They are never replaced by catalog
 * stock art anywhere in this application.
 */
import { useRef, useState } from 'react';
import { uploadPhoto, signedUrls, storageMode } from '../lib/db';
import type { InventoryImageRow } from '../lib/db';

export interface CapturedPhoto {
  face: InventoryImageRow['face'];
  path: string;
  previewUrl: string;
}

interface Slot {
  face: InventoryImageRow['face'];
  label: string;
  sub: string;
}

const DEFAULT_SLOTS: Slot[] = [
  { face: 'front', label: 'Front', sub: 'Tap to photograph' },
  { face: 'back', label: 'Back', sub: 'Tap to photograph' },
];

/** Reject obviously wrong files early with a clear message. */
const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

export default function PhotoCapture({
  itemId,
  userId,
  photos,
  onChange,
  slots = DEFAULT_SLOTS,
}: {
  itemId: string;
  userId: string;
  photos: CapturedPhoto[];
  onChange: (next: CapturedPhoto[]) => void;
  slots?: Slot[];
}) {
  const [busyFace, setBusyFace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  async function handleFile(face: InventoryImageRow['face'], file: File | undefined) {
    if (!file) return;
    setError(null);

    if (file.size > MAX_BYTES) {
      setError(
        `That photo is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the 20 MB limit. ` +
        `Try again with a smaller image.`
      );
      return;
    }
    // HEIC from iPhone reports an empty type in some browsers, so accept a
    // blank type rather than blocking a legitimate photo.
    if (file.type && !ALLOWED.includes(file.type)) {
      setError(`${file.type} is not a supported image format.`);
      return;
    }

    setBusyFace(face);
    try {
      const { path } = await uploadPhoto({ file, itemId, userId, face });
      const urls = await signedUrls([path]);
      const next = photos.filter((p) => p.face !== face);
      next.push({ face, path, previewUrl: urls[path] ?? URL.createObjectURL(file) });
      onChange(next);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Upload failed: ${err.message}`
          : 'Upload failed. Check your connection and try again.'
      );
    } finally {
      setBusyFace(null);
      // Clear the input so re-picking the same file fires onChange again.
      const el = inputs.current[face];
      if (el) el.value = '';
    }
  }

  function remove(face: string) {
    onChange(photos.filter((p) => p.face !== face));
  }

  return (
    <div>
      <div className="photo-slots">
        {slots.map((slot) => {
          const photo = photos.find((p) => p.face === slot.face);
          const busy = busyFace === slot.face;
          return (
            <div key={slot.face}>
              <input
                ref={(el) => { inputs.current[slot.face] = el; }}
                type="file"
                accept="image/*"
                capture="environment"
                className="visually-hidden"
                id={`photo-${slot.face}-${itemId}`}
                onChange={(e) => handleFile(slot.face, e.target.files?.[0])}
              />
              <label
                htmlFor={`photo-${slot.face}-${itemId}`}
                className={`photo-slot${photo ? ' filled' : ''}`}
              >
                {photo ? (
                  <>
                    <img src={photo.previewUrl} alt={`${slot.label} of the card`} />
                    <button
                      type="button"
                      className="remove"
                      aria-label={`Remove ${slot.label.toLowerCase()} photo`}
                      onClick={(e) => { e.preventDefault(); remove(slot.face); }}
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <div>
                    <div className="slot-label">{slot.label}</div>
                    <div className="slot-sub">{slot.sub}</div>
                  </div>
                )}
                {busy && <div className="uploading"><span className="spinner" /></div>}
              </label>
            </div>
          );
        })}
      </div>

      {error && <div className="note note-danger mt">{error}</div>}

      <p className="tiny dim mt" style={{ marginBottom: 0 }}>
        {storageMode === 'local'
          ? 'Your photographs are stored in this browser on this device, and are never replaced with catalog images. Export a backup from Settings to keep a copy.'
          : 'Your photographs are stored privately in your own Supabase bucket and are never replaced with catalog images.'}
      </p>
    </div>
  );
}
