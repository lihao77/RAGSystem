import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tools.tool_executor_modules.visualization_tools import create_map, create_bindmap
from tools.visualization_artifact_manager import get_visualization_artifact_manager


def test_create_map_accepts_tabular_geojson_rows_with_value_field():
    payload = [
        {
            "name": "区域A",
            "value": 85,
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[108.2, 22.7], [108.5, 22.7], [108.5, 23.0], [108.2, 23.0], [108.2, 22.7]]],
            },
        }
    ]

    result = create_map(
        data=payload,
        map_type="choropleth",
        title="GeoJSON 边界",
        name_field="name",
        value_field="value",
        session_id="map-test-session",
    )

    assert result.success is True
    assert result.content["viz_type"] == "map"
    assert result.content["artifact_id"].startswith("viz_")
    assert result.content["preview"]["map_type"] == "choropleth"
    assert result.content["preview"]["total_points"] == 1

    record = get_visualization_artifact_manager().get_record(result.content["artifact_id"])
    assert record.session_id == "map-test-session"


def test_create_map_accepts_point_rows_with_value_field():
    payload = [
        {"name": "区域A", "value": 1, "geometry": "POINT (108.2 22.7)"}
    ]

    result = create_map(
        data=payload,
        map_type="geojson",
        title="GeoJSON 边界",
        name_field="name",
        value_field="value",
        geometry_field="geometry",
        session_id="geojson-map-session",
    )

    assert result.success is True
    assert result.content["preview"]["map_type"] == "geojson"
    assert result.content["preview"]["total_points"] == 1
    assert result.content["artifact_id"].startswith("viz_")

    record = get_visualization_artifact_manager().get_record(result.content["artifact_id"])
    assert record.session_id == "geojson-map-session"


def test_create_bindmap_accepts_boundary_layer_with_value_field():
    result = create_bindmap(
        layers=[
            {
                "data": [
                    {
                        "name": "行政区A",
                        "value": 1,
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[[108.2, 22.7], [108.5, 22.7], [108.5, 23.0], [108.2, 23.0], [108.2, 22.7]]],
                        },
                    }
                ],
                "map_type": "geojson",
                "label": "行政区边界",
                "name_field": "name",
                "value_field": "value",
            }
        ],
        title="边界叠加图",
        session_id="bindmap-test-session",
    )

    assert result.success is True
    assert result.content["preview"]["map_type"] == "bindmap"
    assert result.content["preview"]["total_layers"] == 1
    assert result.content["preview"]["total_points"] >= 1
    assert result.content["artifact_id"].startswith("viz_")

    record = get_visualization_artifact_manager().get_record(result.content["artifact_id"])
    assert record.session_id == "bindmap-test-session"
