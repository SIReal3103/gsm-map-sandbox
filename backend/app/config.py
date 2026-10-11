import json
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, model_validator, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Region(BaseModel):
    name: str
    display_bbox: tuple[float, float, float, float]
    routing_buffer_degrees: float = Field(ge=0, le=0.1)
    extract_strategy: str
    complete_relation_types: str
    source: str
    source_url: str
    attribution: str
    boundary_note: str

    @model_validator(mode="after")
    def validate_bbox(self):
        w, s, e, n = self.display_bbox
        b = self.routing_buffer_degrees
        if not (-180 <= w-b < e+b <= 180 and -90 <= s-b < n+b <= 90):
            raise ValueError("Invalid WGS84 bbox")
        if self.extract_strategy not in {"smart", "complete_ways"}:
            raise ValueError("Use smart or complete_ways")
        return self

    @property
    def routing_bbox(self):
        w, s, e, n = self.display_bbox
        b = self.routing_buffer_degrees
        return (w-b, s-b, e+b, n+b)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=PROJECT_ROOT / ".env", extra="ignore")
    osm_pbf_path: str = "data/raw/vietnam-latest.osm.pbf"
    region_config_path: str = "config/region.json"
    osrm_base_url: str = "http://127.0.0.1:5000"
    osrm_timeout_seconds: float = Field(default=3, gt=0, le=30)
    max_snap_meters: float = Field(default=100, gt=0, le=1000)
    osrm_image: str = "ghcr.io/project-osrm/osrm-backend:v5.27.1"
    osmium_image: str = "iboates/osmium:1.19.0"

    @field_validator("osrm_base_url")
    @classmethod
    def local_router_only(cls, value):
        url = urlsplit(value)
        if (url.scheme != "http" or url.hostname not in {"127.0.0.1", "localhost", "::1"}
                or url.username or url.password or url.path not in {"", "/"}
                or url.query or url.fragment):
            raise ValueError("OSRM must use a local loopback HTTP URL")
        return value.rstrip("/")

    def resolve(self, value: str) -> Path:
        path = Path(value).expanduser()
        return (path if path.is_absolute() else PROJECT_ROOT / path).resolve()

    @property
    def pbf_path(self):
        return self.resolve(self.osm_pbf_path)

    @property
    def region(self):
        return Region.model_validate(json.loads(self.resolve(self.region_config_path).read_text(encoding="utf-8-sig")))

    @property
    def map_path(self):
        return PROJECT_ROOT / "data/processed/render/streets.geojson"

    @property
    def routing_dir(self):
        return PROJECT_ROOT / "data/routing"
