/**
 * Which Docker resources a cleanup removes. Everything the app creates carries the
 * `bugdetective.role` label, and a cleanup only takes labelled resources whose name starts with
 * the resource prefix (containers, volumes) or whose image repository is one of the app's, so
 * another program's resources are never touched. A longer prefix that starts with this one (a
 * test run's "bugdetective-test-…") counts as the app's for "everything", and labelled images
 * without a tag are always removed, whichever app version built them. The app's BuildKit builder
 * (the container buildx_buildkit_<prefix>-builder0 and the moby/buildkit image) carries none of
 * the app's labels, so no cleanup lists it: "everything" removes it through docker buildx rm.
 */
import type { DockerCleanupScope } from '../../shared/api.ts';

export interface LabelledResources {
  containers: string[];
  volumes: string[];
  networks: string[];
  /** "repository:tag" (or "<none>:<none>" for an untagged image) and the image id. */
  images: { ref: string; id: string }[];
}

export interface CleanupTarget {
  kind: 'container' | 'volume' | 'network' | 'image';
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
  /** The active project: its forwarder and network are in use; those of any other project are leftovers. */
  activeProject?: string | null;
}

const repository = (ref: string) => ref.slice(0, ref.lastIndexOf(':'));
const untagged = (ref: string) => ref.endsWith(':<none>');

/** A container a QA run leaves behind: the run itself, the copy helper or the dependency installer. */
export function isQaContainer(name: string, prefix: string): boolean {
  return name.startsWith(`${prefix}-qa-`);
}

/**
 * The resources to remove, containers first (they hold volumes, networks and images), then
 * volumes, networks and images.
 * leftovers: QA containers, the QA input volume, images of other app versions and the forwarder
 * and network of a project that is not the active one; the player's work stays.
 * everything: every container, volume, network and image of the app, including the player's code.
 */
export function planCleanup(found: LabelledResources, options: CleanupPlanOptions): CleanupTarget[] {
  const everything = options.scope === 'everything';
  const ours = (name: string) => name.startsWith(`${options.prefix}-`);
  const repositories = new Set(options.currentImages.map(repository));
  const current = new Set(options.currentImages);

  const orphan = (name: string, kind: 'forward' | 'net') => {
    const stem = `${options.prefix}-${kind}-`;
    return Boolean(options.activeProject) && name.startsWith(stem) && name !== `${stem}${options.activeProject}`;
  };

  const containers = found.containers.filter((name) => ours(name) && (everything || isQaContainer(name, options.prefix) || orphan(name, 'forward')));
  const volumes = found.volumes.filter((name) => ours(name) && (everything || name === options.qaInputVolume));
  const networks = found.networks.filter((name) => ours(name) && (everything || orphan(name, 'net')));
  const images = found.images.filter(({ ref }) => {
    // Untagged images with the app's label ("<none>:<none>", or "repository:<none>") are what a rebuild leaves behind.
    if (untagged(ref)) {
      return repository(ref) === '<none>' || repositories.has(repository(ref));
    }
    return repositories.has(repository(ref)) && (everything || !current.has(ref));
  });

  return [
    ...containers.map((name) => ({ kind: 'container' as const, name })),
    ...volumes.map((name) => ({ kind: 'volume' as const, name })),
    ...networks.map((name) => ({ kind: 'network' as const, name })),
    // An untagged image is removed by id ("repository:<none>" is no valid reference); a tagged one by
    // its tag, so an id shared with another tag keeps that tag.
    ...images.map(({ ref, id }) => ({ kind: 'image' as const, name: untagged(ref) ? id : ref })),
  ];
}
