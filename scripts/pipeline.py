"""Explicit, bounded local pipeline. --dry-run never reads data or invokes tools."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.app.config import Settings
from backend.app.dataset import GRAPH_FILES


def execute(command, dry_run=False, capture=False):
    print(subprocess.list2cmdline([str(x) for x in command]), flush=True)
    if dry_run:
        return ""
    result = subprocess.run([str(x) for x in command], check=True, text=True,
                            encoding="utf-8", capture_output=capture)
    return result.stdout if capture else ""


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def refuse_existing(paths):
    for path in paths:
        if path.exists():
            raise RuntimeError(f"Không ghi đè artifact đã có: {path}. Kiểm tra output dở dang trước khi chạy lại.")


def image_lock(image, dry):
    if dry:
        return image
    digests = json.loads(execute(["docker", "image", "inspect", image, "--format", "{{json .RepoDigests}}"], capture=True))
    if not digests:
        raise RuntimeError(f"Image chưa có digest: {image}. Pull tag chính thức trước.")
    return digests[0]


class Osmium:
    """Read-only input mount; only the selected output directory is writable."""
    def __init__(self, settings, dry):
        self.dry = dry
        self.image = image_lock(settings.osmium_image, dry)

    def run(self, args, output_dir=None, capture=False):
        converted = []
        for arg in args:
            if isinstance(arg, Path):
                resolved = arg.resolve()
                if output_dir and resolved.is_relative_to(output_dir.resolve()):
                    converted.append("/output/" + resolved.relative_to(output_dir.resolve()).as_posix())
                elif resolved.is_relative_to(ROOT):
                    converted.append("/input/" + resolved.relative_to(ROOT).as_posix())
                else:
                    raise RuntimeError("Docker pipeline chỉ đọc PBF trong project root; sao chép có chủ đích trước.")
            else:
                converted.append(arg)
        command = ["docker", "run", "--rm", "--memory", "5g", "--cpus", "4", "--mount",
                   f"type=bind,source={ROOT},target=/input,readonly"]
        if output_dir:
            if not self.dry:
                output_dir.mkdir(parents=True, exist_ok=True)
            command += ["--mount", f"type=bind,source={output_dir},target=/output"]
        return execute(command + [self.image, *converted], self.dry, capture)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["verify", "extract", "display", "routing", "serve"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--pbf", help="Override OSM_PBF_PATH, relative to project root")
    parser.add_argument("--region-config", help="Override REGION_CONFIG_PATH")
    parser.add_argument("--detach", action="store_true", help="Run router in background")
    args = parser.parse_args(argv)
    settings = Settings(**{k: v for k, v in {"osm_pbf_path": args.pbf, "region_config_path": args.region_config}.items() if v})
    region, dry = settings.region, args.dry_run
    extracted = ROOT / "data/extracted/hcm-center.osm.pbf"
    metadata_path = extracted.with_suffix(".metadata.json")
    graph_pbf = settings.routing_dir / "hcm-center.osm.pbf"
    manifest_path = settings.routing_dir / "manifest.json"
    incomplete = settings.routing_dir / ".incomplete"
    if not dry:
        if not shutil.which("docker"):
            raise RuntimeError("Thiếu Docker CLI. Không tự cài công cụ hệ thống.")
        if execute(["docker", "info", "--format", "{{.OSType}}"], capture=True).strip() != "linux":
            raise RuntimeError("Docker Engine cần Linux containers; khởi động Docker Desktop.")
        if args.action in {"verify", "extract"} and not settings.pbf_path.is_file():
            raise RuntimeError("Thiếu PBF nguồn. Không tải dữ liệu thay thế.")
    now = datetime.now(timezone.utc).isoformat()
    if args.action in {"verify", "extract", "display"}:
        osmium = Osmium(settings, dry)
        if args.action == "verify":
            info = osmium.run(["fileinfo", "-e", "-j", settings.pbf_path], capture=True)
            if not dry:
                write_json(ROOT / "data/processed/source-verification.json", {
                    "path": str(settings.pbf_path), "size_bytes": settings.pbf_path.stat().st_size,
                    "mtime_ns": settings.pbf_path.stat().st_mtime_ns, "sha256": sha256(settings.pbf_path),
                    "format_verified": True, "osmium_image": osmium.image, "created_utc": now,
                    "fileinfo": json.loads(info)})
        elif args.action == "extract":
            if not dry:
                if extracted.exists() and metadata_path.exists():
                    meta = json.loads(metadata_path.read_text(encoding="utf-8"))
                    if (meta.get("extract_sha256") == sha256(extracted) and meta.get("routing_bbox") == list(region.routing_bbox)
                            and meta.get("source_sha256") == sha256(settings.pbf_path) and meta.get("strategy") == region.extract_strategy
                            and meta.get("relation_types") == region.complete_relation_types):
                        print("REUSE verified buffered extract")
                        return 0
                refuse_existing([extracted, metadata_path])
            command = ["extract", "--bbox", ",".join(f"{v:.6f}" for v in region.routing_bbox), "--strategy", region.extract_strategy]
            if region.extract_strategy == "smart":
                command += ["-S", f"types={region.complete_relation_types}"]
            osmium.run(command + ["--set-bounds", "-o", extracted, settings.pbf_path], extracted.parent)
            osmium.run(["check-refs", extracted])
            info = osmium.run(["fileinfo", "-e", "-j", extracted], capture=True)
            if not dry:
                version = osmium.run(["--version"], capture=True).splitlines()[0]
                write_json(metadata_path, {"created_utc": now, "source": region.source,
                    "attribution": region.attribution, "source_path": str(settings.pbf_path),
                    "source_sha256": sha256(settings.pbf_path), "extract_sha256": sha256(extracted),
                    "size_bytes": extracted.stat().st_size, "display_bbox": region.display_bbox,
                    "routing_bbox": region.routing_bbox, "strategy": region.extract_strategy,
                    "relation_types": region.complete_relation_types, "format_verified": True,
                    "osmium_image": osmium.image, "osmium_version": version, "fileinfo": json.loads(info)})
        else:
            from scripts.render_data import prepare_display
            prepare_display(settings, extracted, osmium, dry)
        return 0
    image = image_lock(settings.osrm_image, dry)
    mount = f"type=bind,source={settings.routing_dir},target=/data"
    if args.action == "routing":
        if not dry:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if metadata.get("routing_bbox") != list(region.routing_bbox) or metadata.get("extract_sha256") != sha256(extracted):
                raise RuntimeError("Extract không khớp metadata/bbox; dừng preprocess.")
            if manifest_path.exists() and not incomplete.exists():
                old = json.loads(manifest_path.read_text(encoding="utf-8"))
                if (old.get("extract_sha256") == sha256(extracted) and old.get("image_digest") == image
                        and all((settings.routing_dir / name).is_file() for name in GRAPH_FILES)
                        and all((settings.routing_dir / name).stat().st_size == size for name, size in old.get("artifact_sizes", {}).items())):
                    print("REUSE completed MLD graph")
                    return 0
            refuse_existing([graph_pbf, manifest_path, incomplete, *settings.routing_dir.glob("hcm-center.osrm*")])
            settings.routing_dir.mkdir(parents=True, exist_ok=True)
            incomplete.write_text("MLD pipeline running; do not serve until manifest completes", encoding="utf-8")
            shutil.copyfile(extracted, graph_pbf)
        else:
            print(f"COPY {extracted} -> {graph_pbf}")
        base = ["docker", "run", "--rm", "--memory", "2g", "--cpus", "4", "--mount", mount, image]
        execute(base + ["osrm-extract", "-p", "/opt/car.lua", "/data/hcm-center.osm.pbf"], dry)
        execute(base + ["osrm-partition", "/data/hcm-center.osrm"], dry)
        execute(base + ["osrm-customize", "/data/hcm-center.osrm"], dry)
        if not dry:
            if not all((settings.routing_dir / name).is_file() and (settings.routing_dir / name).stat().st_size > 0 for name in GRAPH_FILES):
                raise RuntimeError("MLD artifacts chưa đầy đủ; giữ .incomplete để ngăn serving.")
            version = execute(["docker", "run", "--rm", image, "osrm-routed", "--version"], capture=True).strip()
            profile_hash = execute(["docker", "run", "--rm", image, "sha256sum", "/opt/car.lua"], capture=True).split()[0]
            write_json(manifest_path, {"algorithm": "mld", "profile": "car", "profile_path": "/opt/car.lua", "profile_sha256": profile_hash,
                "image": settings.osrm_image, "image_digest": image, "osrm_version": version,
                "routing_bbox": region.routing_bbox, "attribution": region.attribution,
                "input_path": str(graph_pbf), "extract_path": str(extracted), "extract_sha256": sha256(extracted),
                "input_sha256": sha256(graph_pbf), "created_utc": now,
                "artifact_sizes": {p.name: p.stat().st_size for p in settings.routing_dir.glob("hcm-center.osrm*")}})
            incomplete.unlink()
    else:
        if not dry and (incomplete.exists() or not manifest_path.is_file() or not all((settings.routing_dir / p).is_file() for p in GRAPH_FILES)):
            raise RuntimeError("Thiếu manifest/graph MLD hoặc pipeline dở dang.")
        if not dry:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("image_digest") != image or manifest.get("routing_bbox") != list(region.routing_bbox):
                raise RuntimeError("Image hoặc bbox không khớp graph đã dựng; không serve bằng cấu hình khác.")
            for name, size in manifest["artifact_sizes"].items():
                if Path(name).name != name or not name.startswith("hcm-center.osrm.") or not (settings.routing_dir / name).is_file() or (settings.routing_dir / name).stat().st_size != size:
                    raise RuntimeError("Graph artifact bị thiếu hoặc thay đổi.")
            existing = subprocess.run(["docker", "container", "inspect", "gsm-map-osrm"], capture_output=True, text=True, encoding="utf-8")
            if existing.returncode == 0:
                container = json.loads(existing.stdout)[0]
                mounts = container.get("Mounts", [])
                owned = (container["Config"].get("Labels", {}).get("gsm-map-sandbox") == "true"
                         and container["Config"].get("Image") == image
                         and any(Path(m["Source"]).resolve() == settings.routing_dir.resolve() and m["Destination"] == "/data" and not m["RW"] for m in mounts)
                         and container["HostConfig"]["PortBindings"].get("5000/tcp") == [{"HostIp": "127.0.0.1", "HostPort": "5000"}])
                if owned and container["State"]["Running"]:
                    print("REUSE running local sandbox router; HTTP readiness is checked by backend/audit")
                    return 0
                raise RuntimeError("Tên container đã được dùng hoặc cấu hình không khớp; không tự dừng container khác.")
        execute(["docker", "run", "--rm", *(["--detach"] if args.detach else []), "--name", "gsm-map-osrm",
                 "--label", "gsm-map-sandbox=true", "--memory", "1g", "--cpus", "2", "-p", "127.0.0.1:5000:5000",
                 "--mount", mount + ",readonly", image, "osrm-routed", "--algorithm", "mld", "/data/hcm-center.osrm"], dry)
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"DỪNG: {exc}", file=sys.stderr)
        sys.exit(1)
