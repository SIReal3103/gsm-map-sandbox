import math
from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field, AfterValidator, model_validator


def valid_coordinate(value):
    lon, lat = value
    if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
        raise ValueError("Expected finite WGS84 [longitude, latitude]")
    return value


Coordinate = Annotated[tuple[Annotated[float, Field(strict=True)], Annotated[float, Field(strict=True)]], AfterValidator(valid_coordinate)]


class RouteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: Coordinate
    end: Coordinate


class SnapPoint(BaseModel):
    location: Coordinate
    distance: float = Field(ge=0, allow_inf_nan=False)
    name: str = ""


class RouteResponse(BaseModel):
    coordinates: list[Coordinate] = Field(min_length=2)
    distance: float = Field(gt=0, allow_inf_nan=False)
    duration: float = Field(gt=0, allow_inf_nan=False)
    snap_points: list[SnapPoint] = Field(min_length=2, max_length=2)
    duration_source: str = "OSRM car profile estimate; not live traffic"
    segment_durations: list[Annotated[float, Field(ge=0, allow_inf_nan=False)]] | None = None
    segment_distances: list[Annotated[float, Field(ge=0, allow_inf_nan=False)]] | None = None
    segment_time_source: str = "OSRM annotations exclude turn delays; normalized to route duration during playback"

    @model_validator(mode="after")
    def validate_segments(self):
        if self.segment_durations is None and self.segment_distances is None:
            return self
        if (self.segment_durations is None or self.segment_distances is None
                or len(self.segment_durations) != len(self.coordinates) - 1
                or len(self.segment_distances) != len(self.coordinates) - 1
                or sum(self.segment_durations) <= 0 or sum(self.segment_distances) <= 0):
            raise ValueError("Segment annotations must align with full route geometry")
        return self
