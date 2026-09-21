ALTER TABLE moods
ADD COLUMN overall_scale INTEGER
CHECK (
  overall_scale IS NULL
  OR (
    typeof(overall_scale) = 'integer'
    AND overall_scale BETWEEN 1 AND 5
  )
);
