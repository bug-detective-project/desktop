/**
 * Which Docker resources a cleanup removes. Everything the app creates carries the
 * `bugdetective.role` label; names add the resource prefix (containers, volumes) or the image
 * repository, so a cleanup never touches another program's resources, nor a test run's.
 */
import type { DockerCleanupScope } from '../../shared/api.ts';

export interface LabelledResources {
  containers: string[];
  volumes: string[];
  /** "repository:tag" (or "<none>:<none>" for an untagged image) and the image id. */
  images: { ref: string; id: string }[];
}

export interface CleanupTarget {
  kind: 'container' | 'volume' | 'image';
  /** The name shown to the player, and the reference passed to docker. */
  name: string;
}

export interface CleanupPlanOptions {
  scope: DockerCleanupScope;
  /** Resource prefix, such as "bugdetective". */
  prefix: string;
  /** The QA input volume (a leftover between QA runs). */
  qaInputVolume: string;
  /** The image tags of this app version ("repository:tag"). */
  currentImages: readonly string[];
}

const repository = (ref: string) => ref.slice(0, ref.lastIndexOf(':'));

/**
 * The resources to remove, containers first (they hold volumes and images), then volumes, then images.
 * leftovers: QA containers, the QA input volume and images of other app versions; the player's work stays.
 * everything: every container, volume and image of the app, including the player's code.
 */
export function planCleanup(found: LabelledResources, options: CleanupPlanOptions): CleanupTarget[] {
  const everything = options.scope === 'everything';
  const ours = (name: string) => name.startsWith(`${options.prefix}-`);
  const repositories = new Set(options.currentImages.map(repository));
  const current = new Set(options.currentImages);

  const containers = found.containers.filter((name) => ours(name) && (everything || name.startsWith(`${options.prefix}-qa-`)));
  const volumes = found.volumes.filter((name) => ours(name) && (everything || name === options.qaInputVolume));
  const images = found.images.filter(({ ref }) => {
    // Untagged images with the app's label are what a rebuild leaves behind.
    if (ref === '<none>:<none>') {
      return true;
    }
    return repositories.has(repository(ref)) && (everything || !current.has(ref));
  });

  return [
    ...containers.map((name) => ({ kind: 'container' as const, name })),
    ...volumes.map((name) => ({ kind: 'volume' as const, name })),
    // An untagged image is removed by id; a tagged one by its tag, so a shared id keeps its other tags.
    ...images.map(({ ref, id }) => ({ kind: 'image' as const, name: ref === '<none>:<none>' ? id : ref })),
  ];
}
