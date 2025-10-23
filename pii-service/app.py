from flask import Flask, request, jsonify
from presidio_analyzer import AnalyzerEngine

app = Flask(__name__)

# Load analyzer once at startup - this is the expensive operation (15-20s)
print("Loading Presidio analyzer and spaCy model...", flush=True)
analyzer = AnalyzerEngine(supported_languages=['en'])
print("Analyzer ready", flush=True)


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'}), 200


@app.route('/analyze', methods=['POST'])
def analyze():
    data = request.get_json()

    if not data or 'text' not in data:
        return jsonify({'error': 'Missing text field'}), 400

    text = data['text']

    # Analyze for PII - fast since model is already loaded
    results = analyzer.analyze(text=text, language='en')

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
