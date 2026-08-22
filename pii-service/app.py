from flask import Flask, request, jsonify
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import SpacyNlpEngine

app = Flask(__name__)

# Load analyzer once at startup - this is the expensive operation (15-20s)
print("Loading Presidio analyzer and spaCy model...", flush=True)

# Force use of small model only
nlp_config = {
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}]
}
nlp_engine = SpacyNlpEngine(models=nlp_config["models"])
analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=['en'])

print("Analyzer ready", flush=True)


@app.route('/health', methods=['GET'])
def health():
    # Run a real (tiny) analysis so the 10s Docker healthcheck keeps the
    # spaCy model's pages resident. A no-op health endpoint lets the kernel
    # swap the model out between edits on the 454MB droplet, making the
    # next real request take ~12s and blow the bot's timeout.
    analyzer.analyze(text='ping', language='en', score_threshold=0.4)
    return jsonify({'status': 'ok'}), 200


@app.route('/analyze', methods=['POST'])
def analyze():
    data = request.get_json()

    if not data or 'text' not in data:
        return jsonify({'error': 'Missing text field'}), 400

    text = data['text']
    blocked_types = data.get('blocked_entity_types', None)

    # Analyze for PII - fast since model is already loaded
    # score_threshold filters out Presidio's low-confidence regex matches
    # (e.g. driver's license 0.3/0.01, bare SSN 0.05, passport 0.05-0.1) that
    # fire on URL IDs, timestamps, version numbers, and citation tags in diffs.
    # Validated/context-boosted real PII scores at or above 0.4.
    results = analyzer.analyze(text=text, language='en', score_threshold=0.4)

    # Filter results to only blocked entity types if specified
    if blocked_types:
        results = [r for r in results if r.entity_type in blocked_types]

    entities = [{
        'type': r.entity_type,
        'score': r.score,
        'start': r.start,
        'end': r.end
    } for r in results]

    return jsonify({
        'has_pii': len(results) > 0,
        'entities': entities
    })


if __name__ == '__main__':
    # This block only runs during local development
    # Production uses Gunicorn
    app.run(host='0.0.0.0', port=5000)
