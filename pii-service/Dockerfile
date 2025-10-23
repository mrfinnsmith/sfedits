FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for health checks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir \
    presidio-analyzer==2.2.360 \
    spacy>=3.4.4 \
    flask>=3.0.0 \
    gunicorn>=21.0.0 \
    && python -m spacy download en_core_web_sm

# Copy application
COPY app.py .

EXPOSE 5000

# Run with Gunicorn
# - Single worker to conserve memory (512MB constraint)
# - Timeout increased for model loading
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--timeout", "30", "app:app"]
